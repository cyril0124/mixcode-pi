import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIXCODE_FOCUSED_TAB_TITLE_ENV,
  MIXCODE_TAB_TITLE_ENV,
  mixCodeSpawnEnvContribution,
} from "../src/core/tab-env.js";

// The bracket consumer treats `undefined` as "ensure unset during the spawn";
// these tests defend that exact map shape.

test("contribution carries trimmed titles", () => {
  const env = mixCodeSpawnEnvContribution({
    tabTitle: "  Agent-01  ",
    focusedTabTitle: "Agent-02",
  });
  assert.deepEqual(env, {
    [MIXCODE_TAB_TITLE_ENV]: "Agent-01",
    [MIXCODE_FOCUSED_TAB_TITLE_ENV]: "Agent-02",
  });
});

test("empty titles map to undefined (ensure-unset), not empty strings", () => {
  const env = mixCodeSpawnEnvContribution({ tabTitle: "", focusedTabTitle: "   " });
  assert.deepEqual(Object.keys(env), [MIXCODE_TAB_TITLE_ENV, MIXCODE_FOCUSED_TAB_TITLE_ENV]);
  assert.equal(env[MIXCODE_TAB_TITLE_ENV], undefined);
  assert.equal(env[MIXCODE_FOCUSED_TAB_TITLE_ENV], undefined);
});
