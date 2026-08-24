import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  formatModelCatalog,
  isListModelsCliArgs,
  loadModelCatalog,
  parseListModelsArgs,
  type ModelListEntry,
} from "../src/cli/models-list.js";

const MODELS_JSON = `{
  "providers": {
    "with-auth": {
      "baseUrl": "https://with-auth.example.test/v1",
      "api": "openai-completions",
      "apiKey": "$MIXCODE_TEST_LIST_MODELS_KEY",
      "models": [
        {
          "id": "capped-thinker",
          "reasoning": true,
          "contextWindow": 256000,
          "maxTokens": 1,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": "low",
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
          }
        },
        { "id": "plain", "contextWindow": 128000, "maxTokens": 1 }
      ]
    },
    "no-auth": {
      "baseUrl": "https://no-auth.example.test/v1",
      "api": "openai-completions",
      "models": [{ "id": "hidden", "contextWindow": 8000, "maxTokens": 1 }]
    }
  }
}`;

async function withCatalogFixture<T>(
  settings: string | undefined,
  run: (dirs: { agentDir: string; stateDir: string }) => Promise<T>,
): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-list-models-agent-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-list-models-state-"));
  const oldKey = process.env.MIXCODE_TEST_LIST_MODELS_KEY;
  try {
    process.env.MIXCODE_TEST_LIST_MODELS_KEY = "test-key";
    await fs.writeFile(path.join(agentDir, "models.json"), MODELS_JSON, "utf8");
    if (settings) {
      await fs.writeFile(path.join(stateDir, "mixcode_settings.json"), settings, "utf8");
    }
    return await run({ agentDir, stateDir });
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_TEST_LIST_MODELS_KEY;
    else process.env.MIXCODE_TEST_LIST_MODELS_KEY = oldKey;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

test("parseListModelsArgs takes one search term plus --json/--help", () => {
  assert.equal(isListModelsCliArgs(["--list-models"]), true);
  assert.equal(isListModelsCliArgs(["--list-models", "gpt"]), true);
  assert.equal(isListModelsCliArgs(["status"]), false);
  assert.deepEqual(parseListModelsArgs([]), { json: false });
  assert.deepEqual(parseListModelsArgs(["gpt", "--json"]), { json: true, search: "gpt" });
  assert.equal(parseListModelsArgs(["--help"]).help, true);
  assert.throws(() => parseListModelsArgs(["--nope"]), /Unknown list-models argument: --nope/);
  assert.throws(() => parseListModelsArgs(["a", "b"]), /Unexpected argument: b/);
});

test("loadModelCatalog lists auth-configured models with their real thinking levels", async () => {
  await withCatalogFixture(undefined, async ({ agentDir, stateDir }) => {
    const catalog = await loadModelCatalog({ agentDir, stateDir });
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));

    // thinkingLevelMap holes are not offered by /thinking, so they must not be listed.
    assert.deepEqual(byId.get("with-auth/capped-thinker")?.thinking, ["low", "high", "max"]);
    // A non-reasoning model still accepts "off" only.
    assert.deepEqual(byId.get("with-auth/plain")?.thinking, ["off"]);
    // Providers without resolvable auth stay out of the list, like in /models.
    assert.equal(byId.has("no-auth/hidden"), false);
    // The faux default heads the list, matching the picker.
    assert.equal(catalog[0]?.id, "faux/faux-1");
    assert.equal(byId.get("with-auth/capped-thinker")?.disabled, false);
  });
});

test("loadModelCatalog stamps mixcode_settings disable lists and filters by search", async () => {
  const settings = `{ "disabledModels": ["with-auth/plain"], "disabledProviders": ["faux"] }`;
  await withCatalogFixture(settings, async ({ agentDir, stateDir }) => {
    const catalog = await loadModelCatalog({ agentDir, stateDir });
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("with-auth/plain")?.disabled, true);
    assert.equal(byId.get("faux/faux-1")?.disabled, true);
    assert.equal(byId.get("with-auth/capped-thinker")?.disabled, false);

    const filtered = await loadModelCatalog({ agentDir, stateDir, search: "CAPPED" });
    assert.deepEqual(
      filtered.map((entry) => entry.id),
      ["with-auth/capped-thinker"],
    );
  });
});

test("formatModelCatalog renders thinking levels and the disabled marker", () => {
  const entries: ModelListEntry[] = [
    {
      id: "acme/thinker",
      provider: "acme",
      modelId: "thinker",
      displayName: "acme/thinker",
      contextWindow: 1_000_000,
      reasoning: true,
      disabled: false,
      thinking: ["low", "high"],
    },
    {
      id: "acme/off-only",
      provider: "acme",
      modelId: "off-only",
      displayName: "acme/off-only",
      contextWindow: 128_000,
      reasoning: false,
      disabled: true,
      thinking: [],
    },
  ];
  const lines = formatModelCatalog(entries).split("\n");
  assert.match(lines[0]!, /^provider\s+model\s+context\s+thinking$/);
  assert.match(lines[1]!, /^acme\s+thinker\s+1M\s+low,high$/);
  assert.match(lines[2]!, /^acme\s+off-only\s+128K\s+-\s+\(disabled\)$/);
});
