import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeThemeId,
  resolveThemeInput,
  THEMES,
  themeArgumentCompletions,
} from "../src/index.js";

test("normalizeThemeId maps known id and alias to canonical id, unknown to undefined, trims/case-folds", () => {
  const [primary] = THEMES;
  assert.ok(primary);

  assert.equal(normalizeThemeId(primary.id), primary.id);
  assert.equal(normalizeThemeId(`  ${primary.id.toUpperCase()}  `), primary.id);

  const aliased = THEMES.find((theme) => (theme.aliases ?? []).length > 0);
  assert.ok(aliased?.aliases?.[0]);
  assert.equal(normalizeThemeId(aliased.aliases[0]), aliased.id);
  assert.equal(normalizeThemeId(` ${aliased.aliases[0].toUpperCase()} `), aliased.id);

  assert.equal(normalizeThemeId("not-a-theme"), undefined);
  assert.equal(normalizeThemeId("  "), undefined);
});

test("resolveThemeInput returns exact id for known themes", () => {
  for (const theme of THEMES) {
    assert.equal(resolveThemeInput(theme.id), theme.id);
    assert.equal(resolveThemeInput(`  ${theme.id.toUpperCase()}  `), theme.id);
    for (const alias of theme.aliases ?? []) {
      assert.equal(resolveThemeInput(alias), theme.id);
    }
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
    "dark",
    "mixcode",
    "claude-warm",
    "claude",
    "warm",
    "tokyo-night",
    "tokyo",
    "toyko",
    "terminal",
    "light",
  ]) {
    assert.ok(values.includes(required), `missing completion: ${required}`);
  }
  assert.deepEqual(themeArgumentCompletions("mixcode-dark"), []);
  assert.deepEqual(themeArgumentCompletions("  MIXCODE-DARK  "), []);
  assert.deepEqual(themeArgumentCompletions("dark"), []);
});
