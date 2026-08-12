import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMixCodeTabEnv,
  MIXCODE_FOCUSED_TAB_TITLE_ENV,
  MIXCODE_TAB_TITLE_ENV,
} from "../src/core/tab-env.js";

test("applyMixCodeTabEnv sets tab title and optional focused title", () => {
  const env: Record<string, string | undefined> = { KEEP: "1" };
  applyMixCodeTabEnv(env, { tabTitle: "Agent-01", focusedTabTitle: "Agent-02" });
  assert.equal(env[MIXCODE_TAB_TITLE_ENV], "Agent-01");
  assert.equal(env[MIXCODE_FOCUSED_TAB_TITLE_ENV], "Agent-02");
  assert.equal(env.KEEP, "1");
});

test("applyMixCodeTabEnv omits empty focused title and clears prior keys", () => {
  const env: Record<string, string | undefined> = {
    [MIXCODE_TAB_TITLE_ENV]: "old",
    [MIXCODE_FOCUSED_TAB_TITLE_ENV]: "old-focus",
  };
  applyMixCodeTabEnv(env, { tabTitle: "  Agent-03  ", focusedTabTitle: "   " });
  assert.equal(env[MIXCODE_TAB_TITLE_ENV], "Agent-03");
  assert.equal(env[MIXCODE_FOCUSED_TAB_TITLE_ENV], undefined);
});

test("applyMixCodeTabEnv leaves tab key unset when title empty", () => {
  const env: Record<string, string | undefined> = {
    [MIXCODE_TAB_TITLE_ENV]: "stale",
  };
  applyMixCodeTabEnv(env, { tabTitle: "" });
  assert.equal(env[MIXCODE_TAB_TITLE_ENV], undefined);
});
