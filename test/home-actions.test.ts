import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, MIXCODE_FAUX_MODEL, modelToRef } from "./helpers/mixcode.js";
import { materializeSessionFile } from "../src/agent/runtime-session.js";
import {
  closeCommandPalette,
  openCommandPalette,
  selectableCommandPaletteEntries,
} from "../src/core/overlays.js";
import { closeSessionSelector, getSessionSelectorComponent } from "../src/ui/session-resume.js";
import { closeAppOverlay } from "../src/ui/app-overlays.js";
import type { MixCodeEditorActions } from "../src/ui/app-types.js";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "../src/ui/app-editor.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { renderHome } from "../src/ui/rendering/overlays.js";
import { themeForId } from "../src/ui/themes.js";
import { testTui } from "./helpers/tui.js";

function fixture(width = 80, height = 24) {
  const state = createInitialState("/repo");
  const render = () => renderHome(state, width, undefined, 2, height);
  let renders = 0;
  const tui = testTui({ requestRender: () => renders++ });
  const send = (data: string) => handleMixCodeKeyInput(state, data, tui);
  const point = (label: string) => {
    const lines = render().map(stripTerminalSequences);
    const row = lines.findIndex((line) => line.includes(label));
    assert.ok(row >= 0, `missing action ${label}`);
    return { x: lines[row]!.indexOf(label) + 1, y: row + 3 };
  };
  return { state, render, point, send, tui, renders: () => renders };
}

async function runtimeFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-home-actions-"));
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
  });
  const f = fixture();
  f.state.workdir = root;
  f.state.model = modelToRef(MIXCODE_FAUX_MODEL);
  t.after(async () => {
    closeSessionSelector(f.state, f.tui);
    closeAppOverlay(f.tui);
    await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...f, root, runtime };
}

test("Home New session creates one real session on release and exposes startup", async (t) => {
  const f = await runtimeFixture(t);
  const completed = Promise.withResolvers<void>();
  const startup: string[] = [];
  const tui = testTui({
    requestRender: () => {
      startup.push(...f.state.tabs.map((tab) => tab.status));
    },
    showOverlay: (component) => {
      completed.reject(new Error(component.render(100).map(stripTerminalSequences).join("\n")));
      return f.tui.showOverlay(component);
    },
  });
  let draft = "Do not send this draft";
  const editor = {
    getText: () => draft,
    setText: (value: string) => {
      draft = value;
    },
  };
  const send = (data: string) =>
    handleMixCodeKeyInput(
      f.state,
      data,
      tui,
      undefined,
      f.runtime,
      () => completed.resolve(),
      undefined,
      editor,
    );
  const point = f.point("+ New session");
  // A release alone, secondary click, or drag out and back must not create a session.
  send(mouse(0, point, true));
  send(mouse(2, point));
  send(mouse(0, point));
  send(mouse(32, { x: 1, y: point.y }));
  send(mouse(32, point));
  send(mouse(0, point, true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.state.tabs.length, 0);
  send(mouse(0, point));
  assert.equal(f.state.tabs.length, 0, "press only paints feedback");
  send(mouse(0, point, true));
  send(mouse(0, point, true));
  await completed.promise;
  assert.equal(f.state.tabs.length, 1);
  const tab = f.state.tabs[0]!;
  assert.equal(f.state.activeTabId, tab.sessionId);
  assert.equal(tab.status, "idle");
  assert.ok(startup.includes("Not Ready"));
  assert.equal(f.runtime.getTab(tab.sessionId)?.session.getCwd(), f.root);
  assert.equal(draft, "Do not send this draft");
  assert.deepEqual(f.runtime.getTab(tab.sessionId)?.session.buildSessionContext().messages, []);
});

test("Home New session surfaces startup failure and rolls back the empty Home", async (t) => {
  const f = await runtimeFixture(t);
  // A non-directory session root exercises the actual startup I/O boundary.
  await Bun.write(path.join(f.root, "sessions"), "not a directory");
  const failed = Promise.withResolvers<string>();
  const tui = testTui({
    showOverlay: (component) => {
      failed.resolve(component.render(100).map(stripTerminalSequences).join("\n"));
      return f.tui.showOverlay(component);
    },
  });
  const point = f.point("+ New session");
  for (const release of [false, true])
    handleMixCodeKeyInput(f.state, mouse(0, point, release), tui, undefined, f.runtime);
  const error = await failed.promise;
  assert.match(error, /Error/);
  assert.match(error, /ENOTDIR|EEXIST|directory/i);
  assert.equal(f.state.activeTabId, "home");
  assert.deepEqual(f.state.tabs, []);
  assert.deepEqual(f.runtime.listTabs(), []);
  closeAppOverlay(tui);
});

for (const populated of [false, true]) {
  test(`Home Resume restores saved history with ${populated ? "an existing tab" : "no tabs"}`, async (t) => {
    const f = await runtimeFixture(t);
    if (populated) {
      const source = createTab(1, "source", f.root, { model: f.state.model, title: "Source" });
      f.state.tabs.push(source);
      await f.runtime.createTab(source, {
        workdir: f.root,
        systemPrompt: "test",
        model: MIXCODE_FAUX_MODEL,
      });
    }
    const saved = SessionManager.create(f.root, path.join(f.root, "sessions"));
    saved.appendModelChange(MIXCODE_FAUX_MODEL.provider, MIXCODE_FAUX_MODEL.id);
    saved.appendSessionInfo("Saved review");
    saved.appendMessage({
      role: "user",
      content: "Review parser boundaries",
      timestamp: Date.now(),
    });
    materializeSessionFile(saved);
    const opened = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const hostTui = testTui({ setFocus: () => undefined }) as TUI;
    const slot = new EditorSlot(
      hostTui,
      new CompactPromptEditor(
        hostTui,
        editorThemeFor(themeForId(f.state.theme)),
        undefined,
        f.state,
      ),
      f.state,
    );
    const editor: MixCodeEditorActions = {
      getText: () => slot.getText(),
      setText: (text) => slot.setText(text),
      setInputComponent: (component, owner) => slot.setInputComponent(component, owner),
      clearInputComponent: (owner) => slot.clearInputComponent(owner),
      hasInputComponent: () => slot.hasInputComponent(),
    };
    const tui = testTui({
      requestRender: () => {
        const lines = getSessionSelectorComponent(f.state)
          ?.render(100)
          .map(stripTerminalSequences)
          .join("\n");
        if (lines?.includes("Saved review")) opened.resolve();
      },
    });
    const point = f.point("Resume");
    const onChange = () => {
      if (
        f.state.tabs.some((tab) => tab.sessionId === saved.getSessionId() && tab.status === "idle")
      )
        resumed.resolve();
    };
    for (const release of [false, true])
      handleMixCodeKeyInput(
        f.state,
        mouse(0, point, release),
        tui,
        undefined,
        f.runtime,
        onChange,
        undefined,
        editor,
      );
    await opened.promise;
    const selector = getSessionSelectorComponent(f.state);
    assert.ok(selector);
    assert.equal(slot.hasInputComponent(), true);
    assert.match(slot.render(100).map(stripTerminalSequences).join("\n"), /Saved review/);
    selector.handleInput("\r");
    await resumed.promise;
    assert.equal(slot.hasInputComponent(), false);
    assert.equal(f.state.tabs.length, populated ? 2 : 1);
    const restored = f.runtime.getTab(f.state.activeTabId)!;
    assert.equal(restored.session.getSessionFile(), saved.getSessionFile());
    assert.equal(restored.session.getSessionName(), "Saved review");
    assert.match(
      JSON.stringify(restored.session.buildSessionContext().messages),
      /Review parser boundaries/,
    );
  });
}

test("empty Home exposes new and resume in the keyboard command palette", () => {
  const state = createInitialState("/repo");
  const commands = selectableCommandPaletteEntries(state).map((entry) => entry.command);
  assert.ok(commands.includes("/new-session"));
  assert.ok(commands.includes("/resume"));
});

function mouse(button: number, point: { x: number; y: number }, release = false): string {
  return `\x1b[<${button};${point.x};${point.y}${release ? "m" : "M"}`;
}

test("Home buttons expose hover and press without moving cells or repainting within one target", () => {
  const f = fixture();
  const target = f.point("+ New session");
  const normal = f.render();
  f.send(mouse(35, target));
  const hover = f.render();
  assert.notDeepEqual(hover, normal);
  assert.deepEqual(hover.map(stripTerminalSequences), normal.map(stripTerminalSequences));
  const count = f.renders();
  for (let i = 0; i < 1000; i++) f.send(mouse(35, target));
  assert.equal(f.renders(), count, "stationary hover must not repaint");
  f.send(mouse(0, target));
  const pressed = f.render();
  assert.notDeepEqual(pressed, hover);
  assert.deepEqual(pressed.map(stripTerminalSequences), normal.map(stripTerminalSequences));
  f.send(mouse(32, { x: 1, y: target.y }));
  f.send(mouse(0, { x: 1, y: target.y }, true));
  assert.deepEqual(f.render(), normal, "dragging out cancels and restores normal appearance");
});

test("Home action capture is cancelled by overlays and resize", () => {
  const f = fixture();
  const target = f.point("+ New session");
  f.send(mouse(0, target));
  openCommandPalette(f.state);
  f.send(mouse(0, target, true));
  closeCommandPalette(f.state);
  assert.equal(f.state.tabs.length, 0);
  const normal = f.render();
  f.send(mouse(0, target));
  renderHome(f.state, 40, undefined, 2, 12);
  assert.deepEqual(f.render(), normal);
});

test("Home actions remain visible in empty viewports without displacing selected agents", () => {
  for (const theme of ["mixcode-dark", "light", "terminal"]) {
    for (const [width, height] of [
      [28, 9],
      [40, 12],
      [80, 24],
      [120, 32],
    ]) {
      const state = createInitialState("/repo");
      const lines = renderHome(state, width!, themeForId(theme), 0, height!);
      assert.match(lines.map(stripTerminalSequences).join("\n"), /\+ New session/);
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      state.tabs.push(createTab(1, "s1", "/repo", { title: "Selected-agent" }));
      const populated = renderHome(state, width!, themeForId(theme), 0, height!);
      assert.match(populated.map(stripTerminalSequences).join("\n"), /Selected-agent/);
      assert.equal(populated.length, height);
      assert.ok(populated.every((line) => visibleWidth(line) === width));
    }
  }
});
