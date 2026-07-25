import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyDisabledModelFlags,
  assertModelEnabled,
  createInitialState,
  createPicker,
  createTab,
  isModelDisabled,
  loadMixCodeSettings,
  loadRawMixCodeSettings,
  writeRawMixCodeSettings,
  type MixCodeModelRef,
} from "../src/index.js";
import { pickerItems } from "../src/core/pickers.js";
import { applyModelSelection } from "../src/ui/app-actions.js";
import { submitAgentInput } from "../src/ui/agent-tab-actions.js";

const openaiGpt: MixCodeModelRef = {
  provider: "openai",
  modelId: "gpt-4",
  displayName: "openai/gpt-4",
  contextWindow: 128_000,
};
const anthropicOpus: MixCodeModelRef = {
  provider: "anthropic",
  modelId: "claude-opus",
  displayName: "anthropic/claude-opus",
  contextWindow: 200_000,
};

test("isModelDisabled matches provider list and provider/modelId list", () => {
  assert.equal(isModelDisabled("openai", "gpt-4", ["openai"], []), true);
  assert.equal(isModelDisabled("openai", "gpt-4", [], ["openai/gpt-4"]), true);
  assert.equal(isModelDisabled("openai", "gpt-4o", [], ["openai/gpt-4"]), false);
  assert.equal(isModelDisabled("anthropic", "claude-opus", ["openai"], ["openai/gpt-4"]), false);
  // modelId may contain slashes; match on first slash only
  assert.equal(
    isModelDisabled("custom", "org/model", [], ["custom/org/model"]),
    true,
  );
});

test("mixcode settings load/write disabledProviders and disabledModels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-disabled-settings-"));
  const file = join(dir, "mixcode_settings.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        disabledProviders: ["openai", "  "],
        disabledModels: ["anthropic/claude-opus", 1, ""],
      }),
      "utf8",
    );
    const loaded = await loadMixCodeSettings(file);
    assert.deepEqual(loaded.disabledProviders, ["openai"]);
    assert.deepEqual(loaded.disabledModels, ["anthropic/claude-opus"]);

    await writeRawMixCodeSettings(file, {
      disabledProviders: ["google"],
      disabledModels: ["openai/gpt-4"],
    });
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.disabledProviders, ["google"]);
    assert.deepEqual(raw.disabledModels, ["openai/gpt-4"]);
    const rawLoaded = await loadRawMixCodeSettings(file);
    assert.deepEqual(rawLoaded.disabledProviders, ["google"]);
    assert.deepEqual(rawLoaded.disabledModels, ["openai/gpt-4"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyDisabledModelFlags stamps disabled without dropping models", () => {
  const stamped = applyDisabledModelFlags(
    [openaiGpt, anthropicOpus],
    ["openai"],
    ["anthropic/claude-opus"],
  );
  assert.equal(stamped.length, 2);
  assert.equal(stamped[0]!.disabled, true);
  assert.equal(stamped[1]!.disabled, true);

  const onlyProvider = applyDisabledModelFlags([openaiGpt, anthropicOpus], ["openai"], []);
  assert.equal(onlyProvider[0]!.disabled, true);
  assert.equal(onlyProvider[1]!.disabled, undefined);
});

test("models picker marks disabled items and keeps them listed", () => {
  const state = createInitialState("/repo");
  state.availableModels = applyDisabledModelFlags(
    [openaiGpt, anthropicOpus],
    ["openai"],
    [],
  );
  const items = pickerItems("models", state);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.disabled, true);
  assert.match(items[0]!.description, /disabled/i);
  assert.equal(items[1]!.disabled, undefined);
  assert.match(items[1]!.description, /context/);

  const picker = createPicker("models", state);
  assert.equal(picker.items.some((item) => item.id === "openai/gpt-4" && item.disabled), true);
});

test("applyModelSelection rejects disabled models", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { model: anthropicOpus });
  state.tabs = [tab];
  state.model = anthropicOpus;
  const disabled = { ...openaiGpt, disabled: true };
  await assert.rejects(
    () => applyModelSelection(state, tab, disabled),
    /disabled/i,
  );
  assert.equal(tab.model.modelId, "claude-opus");
});

test("assertModelEnabled and submitAgentInput reject disabled current model", async () => {
  const disabled = { ...openaiGpt, disabled: true };
  assert.throws(() => assertModelEnabled(disabled), /disabled/i);
  assert.doesNotThrow(() => assertModelEnabled(openaiGpt));

  const tab = createTab(1, "s1", "/repo", { model: disabled });
  let prompted = false;
  await assert.rejects(
    () =>
      submitAgentInput(
        tab,
        {
          prompt: async () => {
            prompted = true;
          },
          getTab: () => undefined,
        } as never,
        "hello",
      ),
    /disabled/i,
  );
  assert.equal(prompted, false);
});
