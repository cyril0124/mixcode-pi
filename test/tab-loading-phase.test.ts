import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeRenderTheme } from "../src/ui/rendering/context.js";
import { renderHome } from "../src/ui/rendering/overlays.js";
import { createInitialState, createTab } from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

test("Not Ready tab card shows its loading phase in the status chip", () => {
  const state = createInitialState();
  const tab = createTab(1, "session-loading-phase", state.workdir, {
    model: { ...state.model },
    status: "Not Ready",
  });
  tab.loadingPhase = "resources";
  state.tabs.push(tab);

  const rendered = stripAnsi(renderHome(state, 120, activeRenderTheme, 0, 30).join("\n"));
  assert.match(rendered, /\[resources\]/);
  assert.ok(!rendered.includes("[Not Ready]"), "phase label replaces the generic status word");
});

test("Not Ready tab without a phase falls back to [loading]", () => {
  const state = createInitialState();
  const tab = createTab(1, "session-loading-fallback", state.workdir, {
    model: { ...state.model },
    status: "Not Ready",
  });
  state.tabs.push(tab);

  const rendered = stripAnsi(renderHome(state, 120, activeRenderTheme, 0, 30).join("\n"));
  assert.match(rendered, /\[loading\]/);
});

test("ready tabs never show a loading chip", () => {
  const state = createInitialState();
  const tab = createTab(1, "session-loading-done", state.workdir, {
    model: { ...state.model },
  });
  tab.loadingPhase = undefined;
  state.tabs.push(tab);

  const rendered = stripAnsi(
    renderHome(state, 120, activeRenderTheme, 0, 30).join("\n"),
  );
  assert.ok(!/\[(loading|session|resources|transcript)\]/.test(rendered));
});
