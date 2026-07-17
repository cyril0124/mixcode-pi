import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getActiveExtensionThemeId,
  noteActiveExtensionThemeId,
} from "../src/core/active-extension-theme-id.js";

const DEFAULT_THEME = "mixcode-dark";

test("note + get roundtrip for a non-empty theme id", () => {
  try {
    noteActiveExtensionThemeId("tokyo-night");
    assert.equal(getActiveExtensionThemeId(), "tokyo-night");
  } finally {
    noteActiveExtensionThemeId(DEFAULT_THEME);
  }
});

test("whitespace-only note does not change the previous id", () => {
  try {
    noteActiveExtensionThemeId("dracula");
    noteActiveExtensionThemeId("   ");
    assert.equal(getActiveExtensionThemeId(), "dracula");
  } finally {
    noteActiveExtensionThemeId(DEFAULT_THEME);
  }
});

test("trim applied to non-empty padded ids", () => {
  try {
    noteActiveExtensionThemeId("  tokyo-night  ");
    assert.equal(getActiveExtensionThemeId(), "tokyo-night");
  } finally {
    noteActiveExtensionThemeId(DEFAULT_THEME);
  }
});
