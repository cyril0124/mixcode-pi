import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  tabBarHitRegions,
  setTheme,
  themeForId,
  themeSuggestions,
} from "../src/index.js";
import type { MixCodeRuntime } from "../src/index.js";
import type { Model } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL } from "../src/index.js";

type TestChatLine = { role: "system"; text: string };

function assertQuitOverlay(text: string | undefined): void {
  assert.match(text ?? "", /┌/);
  assert.match(text ?? "", /Quit MixCode/);
  assert.match(text ?? "", /\[Y\] Quit/);
}

async function waitFor<T>(read: () => Promise<T>, attempts = 25): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("export chooser shortcuts open selected export text in external editor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-export-chooser-editor-"));
  const captureFile = join(dir, "capture.txt");
  const editorScript = join(dir, "editor.sh");
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const lifecycle: string[] = [];
  let overlayOpen = false;
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
    stop: () => {
      lifecycle.push("stop");
      overlayOpen = false;
    },
    start: () => {
      lifecycle.push("start");
    },
  };
  const systemMessages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, text: string) => systemMessages.push(text),
    getTab: () => ({
      chat: [
        { role: "user" as const, text: "question" },
        { role: "assistant" as const, text: "answer" },
      ],
      reasoning: ["thought"],
    }),
  };
  const editorActions = { editor: editorScript };
  try {
    await writeFile(editorScript, `#!/bin/sh\ncp "$1" "${captureFile}"\n`, { mode: 0o755 });

    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserOpen, true);
    assert.equal(
      handleMixCodeKeyInput(
        state,
        "x",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      undefined,
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x1b[B",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserIndex, 1);
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x1b[A",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserIndex, 0);
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\t",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserIndex, 1);
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x1b[Z",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserIndex, 0);
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "a",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    await waitFor(() => readFile(captureFile, "utf8"));
    assert.equal(state.exportChooserOpen, false);
    assert.match(await readFile(captureFile, "utf8"), /Latest Agent Reply/);
    assert.match(await readFile(captureFile, "utf8"), /answer/);
    assert.deepEqual(systemMessages, []);
    assert.equal(
      overlays.some((overlay) => /Opened export in external editor/.test(overlay)),
      false,
    );

    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\t",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\r",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    await waitFor(async () => {
      const text = await readFile(captureFile, "utf8");
      if (!/Chat Export/.test(text)) throw new Error("chat export not captured yet");
      return text;
    });

    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "u",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    const latestUser = await waitFor(async () => {
      const text = await readFile(captureFile, "utf8");
      if (!/Latest User Message/.test(text)) throw new Error("latest user export not captured yet");
      return text;
    });
    assert.match(latestUser, /question/);

    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "t",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    const thinking = await waitFor(async () => {
      const text = await readFile(captureFile, "utf8");
      if (!/Thinking Export/.test(text)) throw new Error("thinking export not captured yet");
      return text;
    });
    assert.match(thinking, /thought/);

    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    const chat = await waitFor(async () => {
      const text = await readFile(captureFile, "utf8");
      if (!/Chat Export/.test(text)) throw new Error("chat export not captured yet");
      return text;
    });
    assert.match(chat, /\[assistant\] answer/);
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x1b",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserOpen, false);
    await writeFile(editorScript, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "a",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    await waitFor(async () => {
      const overlay = overlays.at(-1) ?? "";
      if (!/External editor exited with 7/.test(overlay))
        throw new Error("editor failure overlay not rendered yet");
      return overlay;
    });
    assert.equal(state.exportChooserOpen, false);
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x0c",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.deepEqual(
      handleMixCodeKeyInput(
        state,
        "\x1b",
        tui,
        undefined,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        editorActions,
      ),
      { consume: true },
    );
    assert.equal(state.exportChooserOpen, false);
    assert.ok(lifecycle.includes("stop"));
    assert.ok(lifecycle.includes("start"));
    assert.ok(renders >= 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
