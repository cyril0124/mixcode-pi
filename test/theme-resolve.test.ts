import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listThemeInfos,
  normalizeThemeId,
  THEMES,
} from "../src/index.js";

test("normalizeThemeId maps known id to itself, unknown to undefined, trims/case-folds", () => {
  const [primary] = THEMES;
  assert.ok(primary);

  assert.equal(normalizeThemeId(primary.id), primary.id);
  assert.equal(normalizeThemeId(`  ${primary.id.toUpperCase()}  `), primary.id);
  assert.equal(normalizeThemeId("not-a-theme"), undefined);
  assert.equal(normalizeThemeId("  "), undefined);
});

test("listThemeInfos includes built-in MixCode ids", () => {
  const ids = listThemeInfos().map((theme) => theme.id);
  for (const required of THEMES.map((theme) => theme.id)) {
    assert.ok(ids.includes(required), `missing theme: ${required}`);
  }
});
