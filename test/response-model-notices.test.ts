import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  appendEmptyRunNotice,
  appendSystemMessage,
  entriesToChatLines,
} from "../src/agent/runtime-chat.js";
import { applyEvent } from "../src/agent/runtime-events.js";
import { loadMixCodeSettings } from "../src/core/mixcode-settings.js";
import { handleCtlRequest } from "../src/core/instance-ctl-server.js";
import { MixCodeRoot } from "../src/ui/app-layout.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { MIXCODE_DARK_THEME } from "../src/ui/themes.js";
import { createSettingsPanel, selectSettingsItemByLabel } from "./helpers/settings-panel.js";
import {
  createInitialState,
  createTab,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  renderConversation,
} from "./helpers/mixcode.js";
import {
  fixtureStream,
  REPORTED_MODEL,
  REQUESTED_MODEL,
  responseEvents,
} from "./helpers/response-model.js";

let dir: string;
let runtime: MixCodeRuntime;
let nextTab = 0;
let response: AssistantMessage;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-response-model-"));
  runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir: path.join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ showCacheMissNotices: false }),
  });
  response = await fixtureStream("openai-responses", responseEvents()).result();
  assert.equal(response.responseModel, REPORTED_MODEL);
});

after(async () => {
  runtime?.beginShutdown();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function freshTab() {
  nextTab++;
  return runtime.createTab(createTab(nextTab, `reported-${nextTab}`, dir), {
    workdir: dir,
    model: MIXCODE_FAUX_MODEL,
    systemPrompt: "Test model metadata display.",
    thinkingLevel: "off",
  });
}

const expectedNotice = `[Model mismatch] requested ${REQUESTED_MODEL} → returned ${REPORTED_MODEL} · via fixture`;

test("streamed response shows one model notice only after completion and survives a later status", async () => {
  const tab = await freshTab();
  applyEvent(tab, { type: "message_start", message: response }, () => {});
  assert.equal(
    tab.chat.some((line) => line.variant === "system-model"),
    false,
  );
  applyEvent(tab, { type: "message_end", message: response }, () => {});
  assert.equal(tab.chat.at(-1)?.text, expectedNotice);
  assert.equal(tab.chat.filter((line) => line.variant === "system-model").length, 1);
  appendSystemMessage(tab, "Ready");
  assert.equal(tab.chat.at(-2)?.text, expectedNotice);
});

test("model differences belong to each response including repeated pairs and model switches", async () => {
  const tab = await freshTab();
  for (const message of [
    response,
    response,
    { ...response, model: "new-request", responseModel: "new-report" },
  ]) {
    applyEvent(tab, { type: "message_start", message }, () => {});
    applyEvent(tab, { type: "message_end", message }, () => {});
  }
  assert.deepEqual(
    tab.chat.filter((line) => line.variant === "system-model").map((line) => line.text),
    [
      expectedNotice,
      expectedNotice,
      "[Model mismatch] requested new-request → returned new-report · via fixture",
    ],
  );
});

test("same, missing, empty and whitespace-only names add no notice", async () => {
  const tab = await freshTab();
  for (const responseModel of [REQUESTED_MODEL, undefined, "", " \t "]) {
    const message = { ...response, responseModel };
    applyEvent(tab, { type: "message_start", message }, () => {});
    applyEvent(tab, { type: "message_end", message }, () => {});
  }
  assert.deepEqual(
    tab.chat.map((line) => line.role),
    ["assistant", "assistant", "assistant", "assistant"],
  );
});

test("snapshot and gateway differences remain literal reported names", async () => {
  const tab = await freshTab();
  const message = {
    ...response,
    model: "claude-haiku-4-5",
    responseModel: "anthropic/claude-haiku-4-5-20251001",
  };
  applyEvent(tab, { type: "message_end", message }, () => {});
  assert.equal(
    tab.chat.at(-1)?.text,
    "[Model mismatch] requested claude-haiku-4-5 → returned anthropic/claude-haiku-4-5-20251001 · via fixture",
  );
});

test("response notices do not count as output from an otherwise empty run", async () => {
  const tab = await freshTab();
  tab.currentRunChatStartIndex = 0;
  applyEvent(tab, { type: "message_end", message: { ...response, content: [] } }, () => {});
  appendEmptyRunNotice(tab);
  assert.deepEqual(
    tab.chat.map((line) => line.text),
    [expectedNotice, "Agent finished without a response."],
  );
});

test("failure, abort, truncation and tool-only replies retain model notices in live and rebuilt chat", async () => {
  const tab = await freshTab();
  for (const stopReason of ["error", "aborted", "length", "toolUse"] as const) {
    const message: AssistantMessage = {
      ...response,
      stopReason,
      content:
        stopReason === "toolUse"
          ? [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } }]
          : [],
      errorMessage: stopReason === "error" ? "Fixture failure" : undefined,
    };
    tab.chat = [];
    applyEvent(tab, { type: "message_end", message }, () => {});
    assert.equal(tab.chat.at(-1)?.text, expectedNotice);
    const session = SessionManager.inMemory(dir);
    session.appendMessage(message);
    const restored = entriesToChatLines(session.getBranch(), tab, []);
    assert.equal(restored.at(-1)?.text, expectedNotice);
  }
});

test("real session persistence and branch selection retain only the selected responses' notices", async () => {
  const tab = await freshTab();
  const userId = tab.session.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
  const firstId = tab.session.appendMessage(response);
  const file = tab.session.getSessionFile();
  assert.ok(file);
  const restored = SessionManager.open(file);
  assert.equal(entriesToChatLines(restored.getBranch(), tab, []).at(-1)?.text, expectedNotice);
  const assistant = restored
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(assistant?.type === "message" && assistant.message.role === "assistant");
  assert.equal(assistant.message.model, REQUESTED_MODEL);
  assert.deepEqual(assistant.message.content, response.content);
  // Display-only lines must not become persisted context messages.
  assert.deepEqual(
    restored
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message),
    [{ role: "user", content: "Hello", timestamp: 1 }, response],
  );

  restored.branch(userId);
  restored.appendMessage({ ...response, responseModel: "branch-model" });
  assert.equal(
    entriesToChatLines(restored.getBranch(), tab, []).at(-1)?.text,
    `[Model mismatch] requested ${REQUESTED_MODEL} → returned branch-model · via fixture`,
  );
  restored.branch(firstId);
  assert.equal(entriesToChatLines(restored.getBranch(), tab, []).at(-1)?.text, expectedNotice);
});

test("legacy sessions restore normally without invented metadata", async () => {
  const tab = await freshTab();
  const { responseModel: _responseModel, ...legacy } = response;
  tab.session.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
  tab.session.appendMessage(legacy);
  const restored = SessionManager.open(tab.session.getSessionFile()!);
  const chat = entriesToChatLines(restored.getBranch(), tab, []);
  assert.deepEqual(
    chat.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hello" },
    ],
  );
});

test("settings toggle hides notices on all tabs immediately and preserves metadata for re-enabling", async () => {
  const first = await freshTab();
  const second = await freshTab();
  const state = createInitialState(dir);
  state.tabs = [first.tab, second.tab];
  for (const tab of [first, second]) {
    applyEvent(tab, { type: "message_end", message: response }, () => {});
  }
  const root = new MixCodeRoot(state, runtime, () => 30);
  const mixcodeFile = path.join(dir, "notice-settings.json");
  const settingsManager = SettingsManager.inMemory();
  let onRender = () => {};
  const panel = createSettingsPanel(state, settingsManager, {
    mixcodeFile,
    tui: {
      requestRender: () => onRender(),
      showOverlay: () => ({ hide() {} }) as never,
    },
  });
  selectSettingsItemByLabel(panel, "Response model notices");
  assert.match(stripTerminalSequences(panel.render(110).join("\n")), /Response model notices/);
  try {
    for (const expected of [true, false, true]) {
      if (state.ui?.showResponseModelNotices !== expected) {
        const rendered = Promise.withResolvers<void>();
        onRender = rendered.resolve;
        panel.handleInput("\r");
        await rendered.promise;
        assert.equal(
          (await loadMixCodeSettings(mixcodeFile)).ui.showResponseModelNotices,
          expected,
        );
      }
      for (const tab of [first, second]) {
        state.activeTabId = tab.tab.sessionId;
        const text = stripTerminalSequences(root.render(110).join("\n"));
        assert.equal(text.includes(expectedNotice), expected);
        assert.match(text, /Hello/);
        assert.equal(tab.chat.at(-1)?.text, expectedNotice);
        const dump = await handleCtlRequest(
          { op: "dump-screen", sessionId: tab.tab.sessionId, width: 110 },
          { state, runtime, injectInput() {} },
        );
        assert.equal(dump.ok, true);
        assert.equal(stripTerminalSequences(dump.text ?? "").includes(expectedNotice), expected);
      }
    }
    assert.equal(settingsManager.getGlobalSettings().showCacheMissNotices, undefined);
    assert.deepEqual(await Bun.file(mixcodeFile).json(), {
      ui: { showResponseModelNotices: true },
    });
  } finally {
    root.dispose();
  }
});

test("response notice visibility invalidates idle conversation caches and applies to long streaming chats", async () => {
  const tab = await freshTab();
  applyEvent(tab, { type: "message_end", message: response }, () => {});
  for (const status of ["idle", "running"] as const) {
    tab.tab.status = status;
    if (status === "running") {
      tab.chat.unshift(
        ...Array.from({ length: 250 }, (_, i) => ({ role: "user" as const, text: `history ${i}` })),
      );
    }
    for (const show of [true, false, true]) {
      const text = stripTerminalSequences(
        renderAgentSurface(tab.tab, tab, 110, 20, MIXCODE_DARK_THEME, {
          showResponseModelNotices: show,
        }).join("\n"),
      );
      assert.equal(text.includes(expectedNotice), show);
      assert.match(text, /Hello/);
    }
  }
});

test("model notices use a colored bracket label and retain all details when wrapped", async () => {
  const tab = await freshTab();
  applyEvent(tab, { type: "message_end", message: response }, () => {});
  const notice = tab.chat.at(-1)!;
  const wide = renderChatBlock(notice, 120, tab.tab, MIXCODE_DARK_THEME);
  assert.equal(wide.length, 1);
  assert.equal(stripTerminalSequences(wide[0]!).trim(), expectedNotice);
  assert.ok(wide[0]!.includes(MIXCODE_DARK_THEME.warning(expectedNotice)));

  const narrow = renderChatBlock(notice, 24, tab.tab, MIXCODE_DARK_THEME);
  for (const row of narrow) assert.ok(visibleWidth(row) <= 24);
  const compact = narrow.map((row) => stripTerminalSequences(row).replace(/\s/g, "")).join("");
  assert.equal(compact, expectedNotice.replace(/\s/g, ""));
});

test("model notices render literal text at narrow widths and strip terminal controls", async () => {
  const tab = await freshTab();
  const message = {
    ...response,
    responseModel: "**reported**\x1b[31m-red\x1b[0m\x1b]9;notify\x07\nnext",
    model: "`requested`",
  };
  applyEvent(tab, { type: "message_end", message }, () => {});
  const notice = tab.chat.at(-1)!;
  const rendered = renderConversation([notice], 24);
  for (const line of rendered) assert.ok(visibleWidth(line) <= 24);
  const text = rendered
    .map(stripTerminalSequences)
    .map((line) => line.trim())
    .join(" ");
  assert.match(text, /\*\*reported\*\*/);
  assert.match(text, /`requested`/);
  assert.doesNotMatch(rendered.join("\n"), /\x1b\]9;notify|\x1b\[31m/);
  assert.equal(
    notice.text,
    "[Model mismatch] requested `requested` → returned **reported**-red next · via fixture",
  );
});
