import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cancelAutoRename, runAutoRename } from "../pi-packages/mpi-auto-rename/index.js";
import { cancelOptimize, runOptimizePrompt } from "../pi-packages/mpi-optimize-prompt/index.js";
import { ProviderCooldownStore } from "../pi-packages/mpi-stuck-guard/provider-watchdog.js";
import { wrapProvider } from "../pi-packages/mpi-stuck-guard/provider-wrapper.js";
import { createAuxModelRegistry, type TestCompletion } from "./helpers/aux-model-registry.js";

const modelRef = { provider: "aux-integration", id: "model" };
const commands = ["auto-rename", "opt-prompt"] as const;
type Command = (typeof commands)[number];

async function fixture(
  t: TestContext,
  command: Command,
  options: {
    auth?: ProviderAuth;
    credentials?: InMemoryCredentialStore;
    complete?: TestCompletion;
  } = {},
) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aux-model-registry-"));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  let requests = 0;
  const { registry, runtime } = await createAuxModelRegistry({
    models: [modelRef],
    auth: options.auth,
    credentials: options.credentials,
    complete: async (...args) => {
      requests++;
      return options.complete ? options.complete(...args) : fauxAssistantMessage("registry-result");
    },
  });
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Fix the request path", timestamp: 1 });
  let editor = "original editor draft";
  const names: string[] = [];
  const notices: string[] = [];
  const widgets: unknown[] = [];
  const abortSlot = {};
  const draftSlot = {};
  const ctx = {
    model: registry.find(modelRef.provider, modelRef.id),
    modelRegistry: registry,
    sessionManager: session,
    hasUI: true,
    ui: {
      getEditorText: () => editor,
      setEditorText: (text: string) => {
        editor = text;
      },
      setWidget: (_name: string, value: unknown) => {
        widgets.push(value);
      },
      notify: (text: string) => {
        notices.push(text);
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    registry,
    runtime,
    ctx,
    notices,
    widgets,
    names,
    get editor() {
      return editor;
    },
    get requests() {
      return requests;
    },
    run: () =>
      command === "auto-rename"
        ? runAutoRename({
            ctx,
            agentDir,
            abortSlot,
            getThinkingLevel: () => "off",
            setSessionName: (name) => {
              names.push(name);
            },
          })
        : runOptimizePrompt({
            ctx,
            agentDir,
            abortSlot,
            draftSlot,
            args: "",
            getThinkingLevel: () => "off",
          }),
    cancel: () =>
      command === "auto-rename" ? cancelAutoRename(abortSlot) : cancelOptimize(abortSlot),
  };
}

for (const command of commands) {
  test(`${command}: a superseded request cannot clear the current progress widget`, async (t) => {
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    t.after(() => {
      releaseFirst.resolve();
      releaseSecond.resolve();
    });
    let requests = 0;
    const run = await fixture(t, command, {
      complete: async () => {
        if (++requests === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return fauxAssistantMessage("first-result");
        }
        secondEntered.resolve();
        await releaseSecond.promise;
        return fauxAssistantMessage("second-result");
      },
    });
    const first = run.run();
    await firstEntered.promise;
    const second = run.run();
    await secondEntered.promise;
    assert.equal(typeof run.widgets.at(-1), "function");
    releaseFirst.resolve();
    assert.deepEqual(await first, { ok: false, reason: "cancelled" });
    assert.equal(
      typeof run.widgets.at(-1),
      "function",
      "the newer request still owns its progress widget",
    );
    releaseSecond.resolve();
    assert.equal((await second).ok, true);
    assert.equal(run.widgets.at(-1), undefined);
    if (command === "auto-rename") assert.deepEqual(run.names, ["second-result"]);
    else assert.equal(run.editor, "second-result");
  });

  test(`${command}: refreshes OAuth and applies credential endpoint on each request`, async (t) => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(modelRef.provider, async () => ({
      type: "oauth",
      access: "expired",
      refresh: "refresh-0",
      expires: 0,
    }));
    let refreshes = 0;
    const seen: Array<{ baseUrl: string; apiKey?: string }> = [];
    const run = await fixture(t, command, {
      credentials,
      auth: {
        oauth: {
          name: "Offline OAuth",
          login: async () => {
            throw new Error("Login must not be called");
          },
          refresh: async (current) => ({
            ...current,
            access: `token-${++refreshes}`,
            refresh: `refresh-${refreshes}`,
            expires: Date.now() + 3_600_000,
          }),
          toAuth: async (current) => ({
            apiKey: current.access,
            baseUrl: `https://${current.access}.invalid/v1`,
          }),
        },
      },
      complete: async (model, _context, options) => {
        seen.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey });
        return fauxAssistantMessage("oauth-result");
      },
    });
    assert.equal((await run.run()).ok, true);
    await credentials.modify(modelRef.provider, async (current) => {
      assert.ok(current?.type === "oauth");
      return { ...current, expires: 0 };
    });
    assert.equal((await run.run()).ok, true);
    assert.equal(refreshes, 2);
    assert.deepEqual(seen, [
      { baseUrl: "https://token-1.invalid/v1", apiKey: "token-1" },
      { baseUrl: "https://token-2.invalid/v1", apiKey: "token-2" },
    ]);
    assert.equal((await credentials.read(modelRef.provider))?.type, "oauth");
    assert.equal(run.widgets.at(-1), undefined);
  });

  test(`${command}: unconfigured authentication preserves user state and reports the provider`, async (t) => {
    const run = await fixture(t, command, {
      auth: { apiKey: { name: "Unconfigured", resolve: async () => undefined } },
    });
    const result = await run.run();
    assert.equal(result.ok, false);
    assert.equal(run.requests, 0);
    assert.deepEqual(run.names, []);
    assert.equal(run.editor, "original editor draft");
    assert.ok(
      run.notices.some((text) => text.includes("Provider is not configured: aux-integration")),
    );
    assert.equal(run.widgets.at(-1), undefined);
  });

  test(`${command}: cancellation during OAuth refresh prevents provider dispatch`, async (t) => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(modelRef.provider, async () => ({
      type: "oauth",
      access: "expired",
      refresh: "r",
      expires: 0,
    }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let authSignal: AbortSignal | undefined;
    const run = await fixture(t, command, {
      credentials,
      auth: {
        oauth: {
          name: "Delayed OAuth",
          login: async () => {
            throw new Error("Unexpected login");
          },
          refresh: async (current, signal) => {
            authSignal = signal;
            entered.resolve();
            await release.promise;
            return { ...current, access: "fresh", expires: Date.now() + 3_600_000 };
          },
          toAuth: async (current) => ({ apiKey: current.access }),
        },
      },
    });
    const pending = run.run();
    await entered.promise;
    assert.equal(run.cancel(), true);
    assert.equal(authSignal?.aborted, true);
    assert.equal(run.widgets.at(-1), undefined);
    release.resolve();
    assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
    assert.equal(run.requests, 0);
    assert.deepEqual(run.names, []);
    assert.equal(run.editor, "original editor draft");
  });

  test(`${command}: requests pass through the configured provider watchdog`, async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const run = await fixture(t, command, {
      complete: async () => {
        await release.promise;
        return fauxAssistantMessage("late-result");
      },
    });
    run.registry.registerProvider(
      wrapProvider(run.registry.getProvider(modelRef.provider)!, {
        enabled: true,
        streamStartTimeoutMs: 25,
        streamIdleTimeoutMs: 25,
        streamRetryStartTimeoutMs: 25,
        knownTimeoutCooldownMs: 100,
        cooldowns: new ProviderCooldownStore(),
      }),
    );
    const result = await run.run();
    assert.equal(result.ok, false);
    assert.ok(run.notices.some((text) => /timeout|timed out/i.test(text)));
    assert.equal(run.requests, 1);
    assert.equal(run.widgets.at(-1), undefined);
    assert.deepEqual(run.names, []);
    assert.equal(run.editor, "original editor draft");
    release.resolve();
  });
}
