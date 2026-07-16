import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMixCodeSettings } from "../src/index.js";

test("mixcode settings default history and oversized assistant message policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-settings-"));
  try {
    assert.deepEqual(await loadMixCodeSettings(join(dir, "missing.json")), {
      history: { maxBytes: 5 * 1024 * 1024 },
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        renderMermaid: true,
      },
    });
    await writeFile(
      join(dir, "mixcode_settings.json"),
      JSON.stringify({
        history: { persistence: "none", maxBytes: 128 },
        ui: {
          oversizedAssistantMessage: { enabled: false, maxLines: 42, maxBytes: 2048 },
          renderMermaid: false,
        },
      }),
      "utf8",
    );
    assert.deepEqual(await loadMixCodeSettings(join(dir, "mixcode_settings.json")), {
      history: { maxBytes: 128 },
      ui: {
        oversizedAssistantMessage: { enabled: false, maxLines: 42, maxBytes: 2048 },
        renderMermaid: false,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings accept jsonc comments and trailing commas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-history-jsonc-settings-"));
  try {
    await writeFile(
      join(dir, "mixcode_settings.json"),
      `{
        // Keep at most 256 bytes of prompt history.
        "history": {
          "maxBytes": 256,
        },
      }`,
      "utf8",
    );

    assert.deepEqual(await loadMixCodeSettings(join(dir, "mixcode_settings.json")), {
      history: { maxBytes: 256 },
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        renderMermaid: true,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings reject invalid oversized assistant message policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-ui-settings-invalid-"));
  const file = join(dir, "mixcode_settings.json");
  try {
    for (const [value, message] of [
      [{ maxLines: "many" }, /ui\.oversizedAssistantMessage\.maxLines must be a positive integer/],
      [{ maxBytes: 0 }, /ui\.oversizedAssistantMessage\.maxBytes must be a positive integer/],
      [{ enabled: "yes" }, /ui\.oversizedAssistantMessage\.enabled must be a boolean/],
      ["bad", /ui\.oversizedAssistantMessage must be an object/],
    ] as const) {
      await writeFile(file, JSON.stringify({ ui: { oversizedAssistantMessage: value } }), "utf8");
      await assert.rejects(() => loadMixCodeSettings(file), message);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings reject invalid renderMermaid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-render-mermaid-invalid-"));
  const file = join(dir, "mixcode_settings.json");
  try {
    await writeFile(file, JSON.stringify({ ui: { renderMermaid: "yes" } }), "utf8");
    await assert.rejects(() => loadMixCodeSettings(file), /ui\.renderMermaid must be a boolean/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
