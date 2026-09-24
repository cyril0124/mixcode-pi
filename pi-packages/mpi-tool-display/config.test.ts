import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { createToolDisplayConfigOverlay } from "./config-overlay.js";
import {
  DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG,
  type ToolDisplayRuntimeConfig,
  loadToolDisplayRuntimeConfig,
  parseToolDisplayRuntimeConfig,
  toolDisplayConfigPath,
  writeToolDisplayRuntimeConfig,
} from "./config.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tool-display-config-"));
  tempDirs.push(dir);
  return dir;
}

function plainTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

test("missing global config defaults raw tool arguments to off", () => {
  const dir = tempDir();
  const loaded = loadToolDisplayRuntimeConfig(dir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.missing, true);
  assert.deepEqual(loaded.config, DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG);
  assert.equal(loaded.path, toolDisplayConfigPath(dir));
});

test("global config round-trips every strict boolean with private permissions", () => {
  const dir = tempDir();
  const written = writeToolDisplayRuntimeConfig(dir, {
    showRawToolArguments: true,
    compactBashCallRow: false,
    compactBashCommandHint: false,
  });
  assert.equal(written.ok, true);
  if (!written.ok) return;
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(written.path, "utf8"),
    '{\n  "showRawToolArguments": true,\n  "compactBashCallRow": false,\n  "compactBashCommandHint": false\n}\n',
  );

  const loaded = loadToolDisplayRuntimeConfig(dir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.missing, false);
  assert.deepEqual(loaded.config, {
    showRawToolArguments: true,
    compactBashCallRow: false,
    compactBashCommandHint: false,
  });
});

test("global config rejects malformed JSON, unknown keys, and wrong values", () => {
  assert.throws(() => parseToolDisplayRuntimeConfig({ extra: true }), /unknown key "extra"/);
  assert.throws(
    () => parseToolDisplayRuntimeConfig({ showRawToolArguments: "yes" }),
    /must be a boolean/,
  );
  assert.throws(
    () => parseToolDisplayRuntimeConfig({ compactBashCallRow: "on" }),
    /compactBashCallRow must be a boolean/,
  );
  assert.throws(
    () => parseToolDisplayRuntimeConfig({ compactBashCommandHint: 1 }),
    /compactBashCommandHint must be a boolean/,
  );
  // An absent key keeps its default instead of failing.
  assert.deepEqual(parseToolDisplayRuntimeConfig({}), DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG);
  assert.deepEqual(parseToolDisplayRuntimeConfig({ compactBashCallRow: false }), {
    showRawToolArguments: false,
    compactBashCallRow: false,
    compactBashCommandHint: true,
  });

  const dir = tempDir();
  fs.writeFileSync(toolDisplayConfigPath(dir), "{", "utf8");
  const loaded = loadToolDisplayRuntimeConfig(dir);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /JSON|position|Expected property name/i);
});

test("config overlay lists every setting and toggles the selected one", () => {
  const changes: Array<Partial<ToolDisplayRuntimeConfig>> = [];
  let closed = false;
  const view = createToolDisplayConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => {
      closed = true;
    },
    configPath: "/tmp/agent/mpi-tool-display.json",
    initial: {
      showRawToolArguments: false,
      compactBashCallRow: true,
      compactBashCommandHint: true,
    },
    persist: (config) => {
      changes.push({ ...config });
      return { ok: true, config };
    },
    onError: () => assert.fail("unexpected persistence error"),
  });

  const initial = stripAnsi(view.render(80).join("\n"));
  assert.match(initial, /^┌.*Tool Display.*┐$/m);
  assert.match(initial, /› Compact bash call row {4}on/);
  assert.match(initial, /Command excerpt\s+on/);
  assert.match(initial, /Raw tool arguments\s+off/);
  assert.match(initial, /One row per finished bash call/);
  assert.match(initial, /\/tmp\/agent\/mpi-tool-display\.json/);
  assert.match(initial, /Esc close/);

  // Enter toggles the selected row only.
  view.handleInput("\r");
  assert.deepEqual(changes, [
    { showRawToolArguments: false, compactBashCallRow: false, compactBashCommandHint: true },
  ]);
  assert.match(stripAnsi(view.render(80).join("\n")), /› Compact bash call row {4}off/);

  // j/down moves to the next row, which owns the excerpt note.
  view.handleInput("j");
  const second = stripAnsi(view.render(80).join("\n"));
  assert.match(second, /› Command excerpt\s+on/);
  assert.match(second, /Dim command excerpt on that row/);

  view.handleInput("\r");
  assert.equal(changes.length, 2);
  assert.equal(changes[1]!.compactBashCommandHint, false);
  assert.equal(changes[1]!.compactBashCallRow, false, "the first toggle survives the second");
  assert.match(stripAnsi(view.render(80).join("\n")), /› Command excerpt\s+off/);

  // j/down reaches the debug row and reveals its warning.
  view.handleInput("j");
  const third = stripAnsi(view.render(80).join("\n"));
  assert.match(third, /› Raw tool arguments\s+off/);
  assert.match(third, /may expose secrets/);

  // Wrapping selection keeps every row reachable.
  view.handleInput("k");
  view.handleInput("k");
  view.handleInput("k");
  assert.match(stripAnsi(view.render(80).join("\n")), /› Raw tool arguments\s+off/);

  view.handleInput("\x1b");
  assert.equal(closed, true);
});

test("config overlay restores the visible value when persistence fails", () => {
  const errors: string[] = [];
  const view = createToolDisplayConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => undefined,
    configPath: "/tmp/agent/mpi-tool-display.json",
    initial: {
      showRawToolArguments: false,
      compactBashCallRow: true,
      compactBashCommandHint: true,
    },
    persist: () => ({ ok: false, error: "disk full" }),
    onError: (message) => errors.push(message),
  });

  view.handleInput(" ");
  assert.deepEqual(errors, ["disk full"]);
  assert.match(stripAnsi(view.render(80).join("\n")), /\boff\b/);
});
