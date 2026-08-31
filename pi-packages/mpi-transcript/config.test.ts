import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_TRANSCRIPT_EDITOR,
  loadTranscriptConfig,
  parseTranscriptConfig,
  transcriptConfigPath,
  writeTranscriptConfig,
} from "./config.js";
import { createTranscriptConfigOverlay } from "./config-overlay.js";
import { resolveTranscriptEditor, transcriptEditorOptions } from "./editor.js";

const theme = { fg: (_color: string, text: string) => text };

test("missing transcript config defaults to auto", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-transcript-config-"));
  try {
    const loaded = loadTranscriptConfig(dir);
    assert.deepEqual(loaded, {
      ok: true,
      path: transcriptConfigPath(dir),
      config: { editor: DEFAULT_TRANSCRIPT_EDITOR },
      missing: true,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("transcript config strictly validates supported keys and modes", () => {
  assert.deepEqual(parseTranscriptConfig({ editor: "nvim" }), { editor: "nvim" });
  assert.deepEqual(parseTranscriptConfig({ $schema: "./mpi-transcript.schema.json" }), {
    editor: "auto",
    schemaRef: "./mpi-transcript.schema.json",
  });
  assert.throws(() => parseTranscriptConfig({ editor: "code" }), /editor must be one of/);
  assert.throws(
    () => parseTranscriptConfig({ $schema: 42 }),
    /\$schema must be a non-empty string/,
  );
  assert.throws(
    () => parseTranscriptConfig({ $schema: "" }),
    /\$schema must be a non-empty string/,
  );
  assert.throws(
    () => parseTranscriptConfig({ $schema: "   " }),
    /\$schema must be a non-empty string/,
  );
  assert.throws(() => parseTranscriptConfig({ unknown: true }), /unknown key/);
  assert.throws(() => parseTranscriptConfig([]), /config root must be an object/);
});

test("transcript config writes and reloads the selected mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-transcript-config-write-"));
  try {
    const written = writeTranscriptConfig(dir, {
      editor: "vim",
      schemaRef: "./mpi-transcript.schema.json",
    });
    assert.equal(written.ok, true);
    assert.deepEqual(JSON.parse(await fs.readFile(transcriptConfigPath(dir), "utf8")), {
      $schema: "./mpi-transcript.schema.json",
      editor: "vim",
    });
    const loaded = loadTranscriptConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.config, written.config);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("transcript editor options include only available external commands", () => {
  assert.deepEqual(
    transcriptEditorOptions((command) => command === "nvim"),
    ["auto", "nvim", "builtin"],
  );
  assert.deepEqual(
    transcriptEditorOptions((command) => command === "vim"),
    ["auto", "vim", "builtin"],
  );
  assert.deepEqual(
    transcriptEditorOptions(() => false),
    ["auto", "builtin"],
  );
  const probes: string[] = [];
  assert.equal(
    resolveTranscriptEditor("auto", (command) => {
      probes.push(command);
      return command === "nvim";
    }),
    "nvim",
  );
  assert.deepEqual(probes, ["nvim"]);
  assert.equal(
    resolveTranscriptEditor("auto", (command) => command === "vim"),
    "vim",
  );
  assert.equal(
    resolveTranscriptEditor("auto", () => false),
    undefined,
  );
  assert.equal(
    resolveTranscriptEditor("builtin", () => true),
    undefined,
  );
});

test("config overlay shows a saved editor and marks removed commands unavailable", () => {
  let saved = "";
  const view = createTranscriptConfigOverlay({
    theme,
    requestRender: () => undefined,
    done: () => undefined,
    configPath: "/tmp/mpi-transcript.json",
    initial: { editor: "nvim" },
    options: ["auto", "vim", "builtin"],
    persist: (config) => {
      saved = config.editor;
      return { ok: true, config };
    },
    onError: (message) => {
      throw new Error(message);
    },
  });
  const rendered = view.render(60).join("\n");
  assert.match(rendered, /nvim \(unavailable\)/);
  assert.doesNotMatch(rendered, /\n│\s+(?:›\s+)?nvim\s+│/);
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.equal(saved, "vim");
});

test("config overlay reports save failures without closing", () => {
  const errors: string[] = [];
  let doneCalls = 0;
  const view = createTranscriptConfigOverlay({
    theme,
    requestRender: () => undefined,
    done: () => {
      doneCalls++;
    },
    configPath: "/tmp/mpi-transcript.json",
    initial: { editor: "auto" },
    options: ["auto", "builtin"],
    persist: () => ({ ok: false, error: "write failed" }),
    onError: (message) => errors.push(message),
  });
  view.handleInput("\r");
  assert.deepEqual(errors, ["write failed"]);
  assert.equal(doneCalls, 0);
  assert.match(view.render(60).join("\n"), /Auto \(nvim > vim > built-in\)/);
});
