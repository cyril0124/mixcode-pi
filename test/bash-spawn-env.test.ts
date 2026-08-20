import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createBashTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab } from "./helpers/mixcode.js";

// Contract under test: the MixCode bash tool's per-spawn env (MIXCODE_TAB_TITLE /
// MIXCODE_FOCUSED_TAB_TITLE) must reach the spawned child even when a display
// extension re-registers "bash" (extension wins the tool-name collision) with a
// fresh upstream createBashTool that knows nothing about MixCode env.

function baseAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "bash-env-test",
    provider: "bash-env-test",
    model: "bash-env-test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function completedStream(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message: AssistantMessage = { ...baseAssistantMessage(), content, stopReason };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

// Both env keys expand inside double quotes in the child bash; `-unset` marks
// a deleted (not merely empty) focused title. `\${` keeps the bash parameter
// expansion literal while satisfying lint/suspicious/noTemplateCurlyInString.
const PROBE_COMMAND = `echo "T=[$MIXCODE_TAB_TITLE] F=[\${MIXCODE_FOCUSED_TAB_TITLE-unset}]"`;

function lastToolResultText(runtimeTab: { session: { getBranch(): unknown[] } }): string {
  const branch = runtimeTab.session.getBranch() as Array<{
    type: string;
    message?: { role: string; content: unknown };
  }>;
  const results = branch.filter(
    (entry) => entry.type === "message" && entry.message?.role === "toolResult",
  );
  assert.ok(results.length > 0, "expected a toolResult entry on the branch");
  return JSON.stringify(results.at(-1)?.message?.content);
}

async function runBashProbe(options: {
  sessionsRoot: string;
  title: string;
  extensionFactories?: ExtensionFactory[];
}): Promise<string> {
  let calls = 0;
  const runtime = new MixCodeRuntime({
    sessionsRoot: options.sessionsRoot,
    extensionFactories: options.extensionFactories ?? [],
    streamFn: () => {
      calls += 1;
      if (calls === 1) {
        return completedStream([fauxToolCall("bash", { command: PROBE_COMMAND })], "toolUse");
      }
      return completedStream([{ type: "text", text: "ok" }]);
    },
  });
  const tab = createTab(1, "s1", options.sessionsRoot, { title: options.title });
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: options.sessionsRoot,
    model: { ...MIXCODE_FAUX_MODEL, provider: "bash-env-test", api: "bash-env-test" },
  });
  await runtime.prompt("s1", "probe env");
  return lastToolResultText(runtimeTab);
}

test("extension bash override still spawns with MIXCODE tab env", async () => {
  // Ambient values (running this suite from inside a healthy mpi tab) must not
  // leak into the child and mask a broken injection path.
  delete process.env.MIXCODE_TAB_TITLE;
  delete process.env.MIXCODE_FOCUSED_TAB_TITLE;
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bash-env-override-"));
  try {
    // pi-tool-display style: re-register "bash" with a fresh upstream tool.
    const bashOverrideExtension: ExtensionFactory = (pi) => {
      pi.registerTool(createBashTool(dir));
    };
    const text = await runBashProbe({
      sessionsRoot: dir,
      title: "EnvProbe",
      extensionFactories: [bashOverrideExtension],
    });
    assert.ok(text.includes("T=[EnvProbe]"), `tab title missing from child env: ${text}`);
    assert.ok(text.includes("F=[unset]"), `focused title should be unset: ${text}`);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("sdk-owned bash tool spawns with MIXCODE tab env", async () => {
  delete process.env.MIXCODE_TAB_TITLE;
  delete process.env.MIXCODE_FOCUSED_TAB_TITLE;
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bash-env-sdk-"));
  try {
    const text = await runBashProbe({ sessionsRoot: dir, title: "SdkProbe" });
    assert.ok(text.includes("T=[SdkProbe]"), `tab title missing from child env: ${text}`);
    assert.ok(text.includes("F=[unset]"), `focused title should be unset: ${text}`);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
