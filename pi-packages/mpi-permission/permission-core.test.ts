import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  addRule,
  createDoomLoopTracker,
  cycleDoomLoop,
  cycleRuleAction,
  evaluateToolCall,
  expandHomeInPattern,
  extractSubject,
  externalPathOf,
  isOutsideCwd,
  loadPermissionConfig,
  matchesPattern,
  parsePermissionConfig,
  removeRule,
  serializePermissionConfig,
  splitBashCommand,
  writePermissionConfig,
  type LayeredConfig,
  type PermissionConfig,
} from "./permission-core.js";

const CWD = "/project/myapp";
const HOME = "/home/alice";

function parsed(raw: unknown): PermissionConfig {
  const result = parsePermissionConfig(raw);
  assert.equal(result.ok, true, `expected valid config: ${JSON.stringify(raw)}`);
  return (result as { ok: true; config: PermissionConfig }).config;
}

function layersOf(...configs: Array<[LayeredConfig["layer"], unknown]>): LayeredConfig[] {
  return configs.map(([layer, raw]) => ({ layer, config: parsed(raw) }));
}

function evaluate(
  layers: LayeredConfig[],
  toolName: string,
  input: Record<string, unknown>,
  doomCount = 0,
) {
  return evaluateToolCall({ layers, toolName, input, cwd: CWD, home: HOME, doomCount });
}

// ─── wildcard matching ───────────────────────────────────────────────────────

test("matchesPattern: * spans any characters including separators", () => {
  assert.equal(matchesPattern("git *", "git status --porcelain"), true);
  assert.equal(matchesPattern("*.env", "/tmp/deep/dir/.env"), true);
  assert.equal(matchesPattern("git *", "gitx status"), false);
});

test("matchesPattern: ? matches exactly one character", () => {
  assert.equal(matchesPattern("v?", "v1"), true);
  assert.equal(matchesPattern("v?", "v12"), false);
  assert.equal(matchesPattern("v?", "v"), false);
});

test("matchesPattern: regex metacharacters are literal", () => {
  assert.equal(matchesPattern("a.b", "a.b"), true);
  assert.equal(matchesPattern("a.b", "axb"), false);
  assert.equal(matchesPattern("x(1)", "x(1)"), true);
});

test("expandHomeInPattern: ~ and $HOME at pattern start", () => {
  assert.equal(expandHomeInPattern("~/projects/*", HOME), "/home/alice/projects/*");
  assert.equal(expandHomeInPattern("$HOME/projects/*", HOME), "/home/alice/projects/*");
  assert.equal(expandHomeInPattern("~", HOME), "/home/alice");
  assert.equal(expandHomeInPattern("a/~/b", HOME), "a/~/b");
});

// ─── config parsing ──────────────────────────────────────────────────────────

test("parse: root string shorthand applies to every tool", () => {
  const decision = evaluate(layersOf(["global", "deny"]), "bash", { command: "ls" });
  assert.equal(decision.action, "deny");
  assert.equal(decision.source?.tool, "*");
});

test("parse: per-tool string shorthand and pattern object", () => {
  const config = parsed({ read: "allow", bash: { "git *": "allow", "*": "ask" } });
  assert.deepEqual(config.entries.map((entry) => entry.tool), ["read", "bash"]);
  assert.equal(config.entries[1]!.rules.length, 2);
});

test("parse: fail loud on invalid action, empty object, bad shapes", () => {
  assert.equal(parsePermissionConfig({ bash: "maybe" }).ok, false);
  assert.equal(parsePermissionConfig({ bash: {} }).ok, false);
  assert.equal(parsePermissionConfig({ bash: 42 }).ok, false);
  assert.equal(parsePermissionConfig({ bash: ["allow"] }).ok, false);
  assert.equal(parsePermissionConfig([]).ok, false);
  assert.equal(parsePermissionConfig("sometimes").ok, false);
  assert.equal(parsePermissionConfig({ doom_loop: { "*": "ask" } }).ok, false);
});

test("$schema: accepted as string, preserved through mutations and file round-trip", () => {
  const config = parsed({ $schema: "./permission.schema.json", bash: { "git *": "allow" } });
  assert.equal(config.schemaRef, "./permission.schema.json");

  const mutated = cycleDoomLoop(addRule(config, "read", "*.env", "deny"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-permission-"));
  const file = path.join(dir, "permission.json");
  assert.equal(writePermissionConfig(file, mutated).ok, true);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(raw)[0], "$schema");
  const loaded = loadPermissionConfig(file);
  assert.equal(loaded.ok, true);
  assert.equal((loaded as { config: PermissionConfig }).config.schemaRef, "./permission.schema.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("$schema: non-string fails loud; evaluation ignores the key", () => {
  assert.equal(parsePermissionConfig({ $schema: { uri: "x" } }).ok, false);
  const layers = layersOf(["global", { $schema: "s", bash: { "rm *": "deny" } }]);
  assert.equal(evaluate(layers, "bash", { command: "rm -rf /" }).action, "deny");
  assert.equal(evaluate(layers, "bash", { command: "ls" }).action, "allow");
});

test("serialize: single * rule collapses to string, order preserved", () => {
  const config = parsed({ read: "allow", bash: { "git *": "allow", "*": "ask" }, doom_loop: "ask" });
  assert.deepEqual(serializePermissionConfig(config), {
    read: "allow",
    bash: { "git *": "allow", "*": "ask" },
    doom_loop: "ask",
  });
});

// ─── config file IO ──────────────────────────────────────────────────────────

test("load/write: round-trips through a real file; missing file reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-permission-"));
  const file = path.join(dir, "permission.json");
  const missing = loadPermissionConfig(file);
  assert.deepEqual(missing, { ok: true, config: null, path: file, missing: true });

  const config = parsed({ bash: { "git push *": "deny", "*": "ask" } });
  const written = writePermissionConfig(file, config);
  assert.equal(written.ok, true);
  const loaded = loadPermissionConfig(file);
  assert.equal(loaded.ok, true);
  assert.deepEqual((loaded as { config: PermissionConfig }).config, config);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("load: invalid JSON and invalid schema fail loud with the file path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-permission-"));
  const file = path.join(dir, "permission.json");
  fs.writeFileSync(file, "{ nope", "utf8");
  const badJson = loadPermissionConfig(file);
  assert.equal(badJson.ok, false);
  assert.match((badJson as { error: string }).error, /invalid JSON/);

  fs.writeFileSync(file, JSON.stringify({ bash: "maybe" }), "utf8");
  const badSchema = loadPermissionConfig(file);
  assert.equal(badSchema.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── bash splitting ──────────────────────────────────────────────────────────

test("splitBashCommand: compound operators split into segments", () => {
  assert.deepEqual(splitBashCommand("git status && rm -rf / ; ls | wc -l"), [
    "git status",
    "rm -rf /",
    "ls",
    "wc -l",
  ]);
});

test("splitBashCommand: quotes collapse to single-space normalized tokens", () => {
  assert.deepEqual(splitBashCommand('git   commit -m "a b"'), ["git commit -m a b"]);
});

test("splitBashCommand: comments and heredoc bodies are not segments", () => {
  assert.deepEqual(splitBashCommand("ls # rm -rf /"), ["ls"]);
  assert.deepEqual(splitBashCommand("cat <<EOF\nrm -rf /\nEOF\necho done"), ["cat <<EOF", "echo done"]);
});

test("splitBashCommand: quoted or commented heredoc markers do not hide following commands", () => {
  assert.deepEqual(splitBashCommand("printf 'x <<EOF'\nrm -rf /"), ["printf x <<EOF", "rm -rf /"]);
  assert.deepEqual(splitBashCommand('printf "x <<EOF"\nrm -rf /'), ["printf x <<EOF", "rm -rf /"]);
  assert.deepEqual(splitBashCommand("echo hi # <<EOF\nrm -rf /"), ["echo hi", "rm -rf /"]);
  assert.deepEqual(splitBashCommand("cat <<< value\nrm -rf /"), ["cat <<< value", "rm -rf /"]);
});

test("splitBashCommand: leading assignments and transparent wrappers are stripped", () => {
  assert.deepEqual(splitBashCommand("FOO=1 sudo rm -rf /"), ["rm -rf /"]);
  assert.deepEqual(splitBashCommand("env FOO=1 git push"), ["git push"]);
  assert.deepEqual(splitBashCommand("$'rm' -rf /"), ["rm -rf /"]);
  assert.deepEqual(splitBashCommand("command rm -rf /"), ["rm -rf /"]);
  assert.deepEqual(splitBashCommand("builtin printf x"), ["printf x"]);
  assert.deepEqual(splitBashCommand("exec rm -rf /"), ["rm -rf /"]);
});

test("splitBashCommand: logical-or and pipe operators split independently", () => {
  assert.deepEqual(splitBashCommand("git status || rm -rf /"), ["git status", "rm -rf /"]);
  assert.deepEqual(splitBashCommand("printf x | wc -c"), ["printf x", "wc -c"]);
});

// ─── evaluation: tool rules ──────────────────────────────────────────────────

test("evaluate: last matching rule wins within one object", () => {
  const layers = layersOf(["global", { bash: { "*": "ask", "git *": "allow", "git push *": "deny" } }]);
  assert.equal(evaluate(layers, "bash", { command: "git status" }).action, "allow");
  assert.equal(evaluate(layers, "bash", { command: "git push origin" }).action, "deny");
  assert.equal(evaluate(layers, "bash", { command: "npm install" }).action, "ask");
});

test("evaluate: later layers win over earlier layers (global -> project -> session)", () => {
  const layers = layersOf(
    ["global", { bash: { "git push *": "deny" } }],
    ["project", { bash: { "git push *": "ask" } }],
  );
  const decision = evaluate(layers, "bash", { command: "git push origin" });
  assert.equal(decision.action, "ask");
  assert.equal(decision.source?.layer, "project");

  const withSession = [...layers, ...layersOf(["session", { bash: { "git push origin": "allow" } }])];
  assert.equal(evaluate(withSession, "bash", { command: "git push origin" }).action, "allow");
});

test("evaluate: * key is the fallback when the tool key has no match", () => {
  const layers = layersOf(["global", { "*": "ask", bash: { "git *": "allow" } }]);
  assert.equal(evaluate(layers, "bash", { command: "git status" }).action, "allow");
  assert.equal(evaluate(layers, "bash", { command: "npm install" }).action, "ask");
  assert.equal(evaluate(layers, "read", { path: "src/a.ts" }).action, "ask");
});

test("evaluate: unmatched call defaults to allow with no source", () => {
  const layers = layersOf(["global", { bash: { "rm *": "deny" } }]);
  const decision = evaluate(layers, "read", { path: "src/a.ts" });
  assert.deepEqual(decision, { action: "allow" });
});

test("evaluate: compound bash takes the most severe segment decision", () => {
  const layers = layersOf(["global", { bash: { "*": "allow", "rm *": "deny", "npm *": "ask" } }]);
  assert.equal(evaluate(layers, "bash", { command: "ls && npm install" }).action, "ask");
  const denied = evaluate(layers, "bash", { command: "ls && npm install && rm -rf /" });
  assert.equal(denied.action, "deny");
  assert.equal(denied.source?.subject, "rm -rf /");
});

test("evaluate: path rules match absolute, relative and bare glob patterns", () => {
  const layers = layersOf([
    "global",
    { read: { "*": "allow", "*.env": "deny" }, edit: { "src/generated/*": "deny" } },
  ]);
  assert.equal(evaluate(layers, "read", { path: ".env" }).action, "deny");
  assert.equal(evaluate(layers, "read", { path: "/etc/secrets/.env" }).action, "deny");
  assert.equal(evaluate(layers, "read", { path: "src/a.ts" }).action, "allow");
  assert.equal(evaluate(layers, "edit", { path: `${CWD}/src/generated/x.ts` }).action, "deny");
  assert.equal(evaluate(layers, "edit", { path: "src/other/x.ts" }).action, "allow");
});

test("evaluate: ~ patterns match home paths", () => {
  const layers = layersOf(["global", { read: { "~/secrets/*": "deny" } }]);
  assert.equal(evaluate(layers, "read", { path: `${HOME}/secrets/key` }).action, "deny");
  assert.equal(evaluate(layers, "read", { path: `${HOME}/public/key` }).action, "allow");
});

test("evaluate: grep/find match their search pattern; unknown tools match JSON input", () => {
  const layers = layersOf([
    "global",
    { grep: { "*secret*": "deny" }, my_tool: { "*dangerous*": "deny" }, other_tool: "deny" },
  ]);
  assert.equal(evaluate(layers, "grep", { pattern: "top secret", path: "src" }).action, "deny");
  assert.equal(evaluate(layers, "grep", { pattern: "hello" }).action, "allow");
  assert.equal(evaluate(layers, "my_tool", { mode: "dangerous" }).action, "deny");
  assert.equal(evaluate(layers, "my_tool", { mode: "safe" }).action, "allow");
  assert.equal(evaluate(layers, "other_tool", { anything: 1 }).action, "deny");
});

// ─── external_directory ──────────────────────────────────────────────────────

test("isOutsideCwd / externalPathOf: cwd containment", () => {
  assert.equal(isOutsideCwd(`${CWD}/src`, CWD), false);
  assert.equal(isOutsideCwd(`${CWD}/..foo`, CWD), false);
  assert.equal(isOutsideCwd(CWD, CWD), false);
  assert.equal(isOutsideCwd("/etc/passwd", CWD), true);
  assert.equal(externalPathOf("read", { path: "src/a.ts" }, CWD), null);
  assert.equal(externalPathOf("read", { path: "/etc/passwd" }, CWD), "/etc/passwd");
  assert.equal(externalPathOf("grep", { pattern: "x", path: "/etc" }, CWD), "/etc");
  assert.equal(externalPathOf("grep", { pattern: "x" }, CWD), null);
  assert.equal(externalPathOf("bash", { command: "cat /etc/passwd" }, CWD), null);
});

test("externalPathOf: resolves symlink escapes through the deepest existing ancestor", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-permission-cwd-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-permission-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "existing.txt"), "secret", "utf8");
    fs.symlinkSync(outside, path.join(cwd, "leak"));
    assert.equal(externalPathOf("read", { path: "leak/existing.txt" }, cwd), path.join(outside, "existing.txt"));
    assert.equal(
      externalPathOf("write", { path: "leak/missing/child.txt" }, cwd),
      path.join(outside, "missing/child.txt"),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("evaluate: external_directory combines with tool rules by severity", () => {
  const layers = layersOf([
    "global",
    { read: "allow", external_directory: { "*": "ask", "~/trusted/**": "allow" } },
  ]);
  assert.equal(evaluate(layers, "read", { path: "src/a.ts" }).action, "allow");
  const asked = evaluate(layers, "read", { path: "/etc/passwd" });
  assert.equal(asked.action, "ask");
  assert.equal(asked.source?.kind, "external_directory");
  assert.equal(evaluate(layers, "read", { path: `${HOME}/trusted/notes.md` }).action, "allow");
});

test("evaluate: external_directory has no * tool-key fallback and no default gate", () => {
  const layers = layersOf(["global", { read: "allow" }]);
  assert.equal(evaluate(layers, "read", { path: "/etc/passwd" }).action, "allow");
});

// ─── doom loop ───────────────────────────────────────────────────────────────

test("doom tracker: counts consecutive identical calls, resets on change", () => {
  const tracker = createDoomLoopTracker();
  assert.equal(tracker.record("bash", { command: "ls" }), 1);
  assert.equal(tracker.record("bash", { command: "ls" }), 2);
  assert.equal(tracker.record("bash", { command: "pwd" }), 1);
  assert.equal(tracker.record("bash", { command: "ls" }), 1);
  assert.equal(tracker.record("bash", { command: "ls" }), 2);
  assert.equal(tracker.record("bash", { command: "ls" }), 3);
  tracker.reset();
  assert.equal(tracker.record("bash", { command: "ls" }), 1);
});

test("evaluate: doom_loop fires at the threshold with the configured action", () => {
  const layers = layersOf(["global", { bash: "allow", doom_loop: "ask" }]);
  assert.equal(evaluate(layers, "bash", { command: "ls" }, 2).action, "allow");
  const tripped = evaluate(layers, "bash", { command: "ls" }, 3);
  assert.equal(tripped.action, "ask");
  assert.equal(tripped.source?.kind, "doom_loop");
});

test("evaluate: later layer overrides doom_loop action", () => {
  const layers = layersOf(["global", { doom_loop: "deny" }], ["session", { doom_loop: "allow" }]);
  assert.equal(evaluate(layers, "bash", { command: "ls" }, 5).action, "allow");
});

// ─── subject extraction ──────────────────────────────────────────────────────

test("extractSubject: per-tool subject kinds", () => {
  assert.deepEqual(extractSubject("bash", { command: "ls -la" }, CWD), {
    kind: "commands",
    segments: ["ls -la"],
  });
  assert.deepEqual(extractSubject("read", { path: "src/a.ts" }, CWD), {
    kind: "path",
    path: `${CWD}/src/a.ts`,
  });
  assert.deepEqual(extractSubject("ls", {}, CWD), { kind: "path", path: CWD });
  assert.deepEqual(extractSubject("grep", { pattern: "foo" }, CWD), { kind: "pattern", pattern: "foo" });
  assert.deepEqual(extractSubject("custom", { a: 1 }, CWD), { kind: "raw", text: '{"a":1}' });
});

// ─── mutation helpers ────────────────────────────────────────────────────────

test("addRule: appended rule wins by last-match; new keys go to the end", () => {
  const base = parsed({ bash: { "git *": "deny" } });
  const withAllow = addRule(base, "bash", "git status *", "allow");
  const layers: LayeredConfig[] = [{ layer: "session", config: withAllow }];
  assert.equal(evaluate(layers, "bash", { command: "git status --short" }).action, "allow");
  assert.equal(evaluate(layers, "bash", { command: "git push" }).action, "deny");

  const withNewKey = addRule(base, "read", "*.env", "deny");
  assert.deepEqual(withNewKey.entries.map((entry) => entry.tool), ["bash", "read"]);
});

test("removeRule: drops the rule and empty keys disappear", () => {
  const base = parsed({ bash: { "git *": "allow" }, read: "deny" });
  const next = removeRule(base, "bash", 0);
  assert.deepEqual(next.entries.map((entry) => entry.tool), ["read"]);
});

test("cycleRuleAction / cycleDoomLoop: full cycles", () => {
  const base = parsed({ bash: { "git *": "allow" } });
  const once = cycleRuleAction(base, "bash", 0);
  assert.equal(once.entries[0]!.rules[0]!.action, "ask");
  assert.equal(cycleRuleAction(once, "bash", 0).entries[0]!.rules[0]!.action, "deny");

  let config = parsed({ read: "allow" });
  assert.equal(config.doomLoop, undefined);
  config = cycleDoomLoop(config);
  assert.equal(config.doomLoop, "ask");
  config = cycleDoomLoop(config);
  assert.equal(config.doomLoop, "deny");
  config = cycleDoomLoop(config);
  assert.equal(config.doomLoop, "allow");
  config = cycleDoomLoop(config);
  assert.equal(config.doomLoop, undefined);
});
