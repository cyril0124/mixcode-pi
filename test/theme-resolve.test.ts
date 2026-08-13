import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeThemeId,
  resolveThemeInput,
  THEMES,
  themeArgumentCompletions,
} from "../src/index.js";

test("normalizeThemeId maps known id to itself, unknown to undefined, trims/case-folds", () => {
  const [primary] = THEMES;
  assert.ok(primary);

  assert.equal(normalizeThemeId(primary.id), primary.id);
  assert.equal(normalizeThemeId(`  ${primary.id.toUpperCase()}  `), primary.id);
  assert.equal(normalizeThemeId("not-a-theme"), undefined);
  assert.equal(normalizeThemeId("  "), undefined);
});

test("resolveThemeInput returns exact id for known themes", () => {
  for (const theme of THEMES) {
    assert.equal(resolveThemeInput(theme.id), theme.id);
    assert.equal(resolveThemeInput(`  ${theme.id.toUpperCase()}  `), theme.id);
  }
});

test("resolveThemeInput throws Unknown theme for garbage", () => {
  assert.throws(() => resolveThemeInput("definitely-not-a-theme"), /Unknown theme/);
});

test("resolveThemeInput rejects ambiguous prefix and accepts unique prefixes", () => {
  assert.throws(() => resolveThemeInput("t"), /Ambiguous theme/);
  assert.equal(resolveThemeInput("te"), "terminal");
  assert.equal(resolveThemeInput("to"), "tokyo-night");
});

test("themeArgumentCompletions lists known values and hides exact matches", () => {
  const values = themeArgumentCompletions("").map((item) => item.value);
  for (const required of [
    "mixcode-dark",
    "claude-warm",
    "tokyo-night",
    "terminal",
    "catppuccin",
    "kanagawa",
    "rose-pine",
    "light",
  ]) {
    assert.ok(values.includes(required), `missing completion: ${required}`);
  }
  assert.deepEqual(themeArgumentCompletions("mixcode-dark"), []);
  assert.deepEqual(themeArgumentCompletions("  MIXCODE-DARK  "), []);
  assert.deepEqual(themeArgumentCompletions("dark"), []);
});
