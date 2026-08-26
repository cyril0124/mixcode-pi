import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type AutocompleteProvider, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  createMixCodeTui,
  type MixCodeRuntime,
} from "./helpers/mixcode.js";

async function waitFor(predicate: () => boolean, attempts = 25): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

// Production path for the external editor command: settings.json externalEditor
// via SettingsManager (createMixCodeTui reads settingsDeps.settingsManager).
function editorSettingsDeps(externalEditor: string) {
  return {
    settingsManager: SettingsManager.inMemory({ externalEditor }),
    mixcodeFile: "/dev/null",
    piSettingsFile: "/dev/null",
  };
}

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

test("createMixCodeTui editor submits prompts and surfaces slash errors", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const prompts: string[] = [];
  const chat: Array<{ role: "user" | "assistant" | "system"; text: string }> = [];
  const runtime = {
    onChange: () => () => undefined,
    getTab: () => ({
      tab,
      chat,
      agentSession: { isStreaming: false, isBashRunning: false },
      session: { getBranch: () => [] },
    }),
    getPromptHistory: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    setExtensionUiHost: () => undefined,
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
    appendSystemMessage: (_sessionId: string, text: string) => {
      chat.push({ role: "system", text });
    },
    clearTabChatProjection: () => {
      chat.length = 0;
    },
    rebuildChatFromSession: () => undefined,
    clearTab: async () => {
      throw new Error("clear failed");
    },
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, {
    terminal: silentTerminal(),
    completionSources: { skills: ["review"] },
  });
  try {
    const layout = (
      tui as unknown as {
        children: Array<{
          editor: {
            getText: () => string;
            setText: (text: string) => void;
            handleInput: (data: string) => void;
            submitCurrentText: () => void;
            isShowingAutocomplete: () => boolean;
            current: Component;
          };
        }>;
      }
    ).children[0]!;

    layout.editor.setText("hello editor");
    layout.editor.handleInput("\r");
    await waitFor(() => prompts.includes("hello editor"));
    assert.equal(layout.editor.getText(), "");

    layout.editor.setText("/clear");
    layout.editor.submitCurrentText();
    await waitFor(() => chat.some((message) => message.text === "Clear failed: clear failed"));

    layout.editor.setText("/does-not-exist");
    layout.editor.submitCurrentText();
    await waitFor(() =>
      chat.some((message) => message.text === "Error: Unknown slash command: /does-not-exist"),
    );
  } finally {
    tui.stop();
  }
});

test("createMixCodeTui external editor rewrites focused draft and surfaces exit errors", async () => {
  const externalDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-external-editor-ok-"));
  const failureDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-external-editor-fail-"));
  try {
    const editorScript = path.join(externalDir, "editor.sh");
    await fsPromises.writeFile(editorScript, `#!/bin/sh\nprintf changed > "$1"\n`, { mode: 0o755 });
    const state = createInitialState("/repo");
    const tab = createTab(1, "s1", "/repo");
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = {
      onChange: () => () => undefined,
      getTab: () => ({ tab, chat: [] }),
      getPromptHistory: () => [],
      onTabClosed: () => () => undefined,
      onModelsChanged: () => () => undefined,
      prompt: async () => undefined,
      getExtensionCommands: () => [],
      getAllExtensionCommands: () => [],
      setExtensionUiHost: () => undefined,
      applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
    } as unknown as MixCodeRuntime;
    let capture = "";
    const tui = createMixCodeTui(state, runtime, {
      terminal: {
        ...silentTerminal(),
        start: () => {
          capture += "start;";
        },
        stop: () => {
          capture += "stop;";
        },
      },
      settingsDeps: editorSettingsDeps(editorScript),
    });
    try {
      const layout = (
        tui as unknown as {
          children: Array<{ editor: { setText: (text: string) => void; getText: () => string } }>;
          handleInput: (data: string) => void;
        }
      ).children[0]!;
      tui.start();
      layout.editor.setText("initial");
      // Public input seam: injectInput feeds the same terminal callback the TUI
      // registers on start(), so the external-editor key travels the real path.
      tui.injectInput("\x07");
      await waitFor(() => layout.editor.getText() === "changed");
      assert.equal(capture, "start;stop;start;");
    } finally {
      tui.stop();
    }

    const failureScript = path.join(failureDir, "editor.sh");
    await fsPromises.writeFile(failureScript, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const failureState = createInitialState("/repo");
    const failureTab = createTab(2, "s2", "/repo");
    failureState.tabs.push(failureTab);
    failureState.activeTabId = "s2";
    const failureTui = createMixCodeTui(failureState, runtime, {
      terminal: silentTerminal(),
      settingsDeps: editorSettingsDeps(failureScript),
    });
    const overlays: string[] = [];
    const originalShowOverlay = failureTui.showOverlay.bind(failureTui);
    failureTui.showOverlay = ((component: Component, options?: OverlayOptions) => {
      overlays.push(component.render?.(80).join("\n") ?? String(component));
      return originalShowOverlay(component, options);
    }) as typeof failureTui.showOverlay;
    try {
      (failureTui as unknown as { handleTerminalInput: (data: string) => void }).handleTerminalInput("\x07");
      await waitFor(() => overlays.some((overlay) => /External editor exited with 7/.test(overlay)));
    } finally {
      failureTui.stop();
    }
  } finally {
    await fsPromises.rm(externalDir, { recursive: true, force: true });
    await fsPromises.rm(failureDir, { recursive: true, force: true });
  }
});

test("createMixCodeTui editor slot renders the input cursor while focused", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = {
    onChange: () => () => undefined,
    getTab: () => ({ tab, chat: [] }),
    getPromptHistory: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    setExtensionUiHost: () => undefined,
    prompt: async () => undefined,
    appendSystemMessage: () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  try {
    const layout = (
      tui as unknown as {
        children: Array<{
          editor: {
            current: Component & { focused?: boolean; getText: () => string };
            handleInput: (data: string) => void;
            setText: (text: string) => void;
            render: (width: number) => string[];
          };
        }>;
      }
    ).children[0]!;

    assert.equal((tui as unknown as { focusedComponent?: unknown }).focusedComponent, layout.editor);
    assert.equal(layout.editor.current.focused, true);

    const emptySurface = layout.editor.render(80).join("\n");
    assert.equal(emptySurface.includes(CURSOR_MARKER), true);
    assert.match(emptySurface, /\x1b\[7m \x1b\[0m/);
    assert.match(stripAnsi(emptySurface), /Send message to Agent-01/);
    // Context usage sits after the title (e.g. "· ?/200k") when known/unknown.
    assert.match(
      stripAnsi(emptySurface).split("\n")[0]!,
      /^─+ Agent-01(?: · \S+)? ──$/,
    );
    assert.equal(visibleWidth(stripAnsi(emptySurface).split("\n")[0]!), 80);
    assert.equal(stripAnsi(emptySurface).split("\n").at(-1), "─".repeat(80));
    assert.doesNotMatch(stripAnsi(emptySurface), /^\s*> /m);

    layout.editor.handleInput("a");
    assert.match(layout.editor.render(80).join("\n"), /a\x1b_pi:c\x07\x1b\[7m \x1b\[0m/);

    layout.editor.setText("x".repeat(120));
    const wrappedSurface = stripAnsi(layout.editor.render(40).join("\n"));
    assert.doesNotMatch(wrappedSurface, /\.\.\./);
    assert.equal(
      wrappedSurface.split("\n").every((line) => visibleWidth(line) <= 40),
      true,
    );

    layout.editor.setText("");
    tab.vimMode = true;
    const vimSurface = layout.editor.render(80).join("\n");
    assert.equal(vimSurface.includes(CURSOR_MARKER), false);
    assert.match(
      stripAnsi(vimSurface),
      /^ Vim: \/ find · n\/N · → newer · Shift\+→ older · j\/k scroll · q exit/m,
    );
    assert.match(
      stripAnsi(vimSurface).split("\n")[0]!,
      /^── \[VIM\] ─+ Agent-01(?: · \S+)? ──$/,
    );
    layout.editor.setText("draft");
    layout.editor.handleInput("x");
    assert.equal(layout.editor.current.getText(), "draft");
  } finally {
    tui.stop();
  }
});
