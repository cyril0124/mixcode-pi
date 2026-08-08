import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectNerdFont,
  resolveGlyphs,
  resolveIconMode,
} from "../src/ui/rendering/icons.js";

test("resolveIconMode forces nerd and ascii", () => {
  assert.equal(resolveIconMode("nerd", {}), "nerd");
  assert.equal(resolveIconMode("ascii", { TERM_PROGRAM: "iTerm.app" }), "ascii");
});

test("resolveIconMode auto detects common nerd terminals", () => {
  assert.equal(resolveIconMode("auto", { TERM_PROGRAM: "iTerm.app" }), "nerd");
  assert.equal(resolveIconMode("auto", { TERM_PROGRAM: "Ghostty" }), "nerd");
  assert.equal(resolveIconMode("auto", { WT_SESSION: "1" }), "nerd");
  assert.equal(resolveIconMode("auto", { TERM: "xterm-kitty" }), "nerd");
  assert.equal(resolveIconMode("auto", {}), "ascii");
});

test("detectNerdFont is false without known terminal markers", () => {
  assert.equal(detectNerdFont({}), false);
  assert.equal(detectNerdFont({ TERM_PROGRAM: "Apple_Terminal" }), false);
});

test("resolveGlyphs returns nerd vs ascii sets", () => {
  const nerd = resolveGlyphs("nerd");
  const ascii = resolveGlyphs("ascii");
  assert.equal(nerd.thinking, "\uf0eb");
  assert.equal(nerd.context, "\uf0c9");
  assert.equal(nerd.statusOn, "\u25cf");
  assert.equal(nerd.statusOff, "\u25cb");
  assert.equal(ascii.thinking, "~");
  assert.equal(ascii.context, "#");
  assert.equal(ascii.barFilled, "#");
  assert.equal(ascii.barEmpty, "-");
  assert.equal(ascii.statusOn, "*");
  assert.equal(ascii.statusOff, "o");
});
