import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { test } from "node:test";
import { inspectBashCommand, tokenize } from "../pi-packages/search-guard/index.ts";

const CWD = "/project/myapp";

// ─── tokenize ────────────────────────────────────────────────────────────────

test("tokenize: basic", () => {
  assert.deepEqual(tokenize("grep -r foo /"), ["grep", "-r", "foo", "/"]);
});

test("tokenize: single quotes", () => {
  assert.deepEqual(tokenize("find '/' -name '*.ts'"), ["find", "/", "-name", "*.ts"]);
});

test("tokenize: double quotes", () => {
  assert.deepEqual(tokenize('grep "foo bar" /home'), ["grep", "foo bar", "/home"]);
});

// ─── inspectBashCommand: safe ─────────────────────────────────────────────────

test("safe: grep in project subdir", () => {
  assert.equal(inspectBashCommand("grep -r foo src/", CWD), null);
});

test("safe: find in relative path", () => {
  assert.equal(inspectBashCommand("find . -name '*.ts'", CWD), null);
});

test("safe: rg in specific dir", () => {
  assert.equal(inspectBashCommand("rg pattern src/core", CWD), null);
});

test("safe: non-search command", () => {
  assert.equal(inspectBashCommand("ls -la /etc", CWD), null);
});

// ─── inspectBashCommand: blocked ─────────────────────────────────────────────

test("blocked: grep targeting /", () => {
  assert.equal(inspectBashCommand("grep -r foo /", CWD), "/");
});

test("blocked: find targeting /", () => {
  assert.equal(inspectBashCommand("find / -name foo", CWD), "/");
});

test("blocked: rg targeting /home", () => {
  assert.equal(inspectBashCommand("rg pattern /home", CWD), "/home");
});

test("blocked: grep targeting /etc", () => {
  assert.equal(inspectBashCommand("grep pattern /etc", CWD), "/etc");
});

test("blocked: find targeting /tmp", () => {
  assert.equal(inspectBashCommand("find /tmp -name '*.log'", CWD), "/tmp");
});

test("blocked: grep targeting ~ (tilde)", () => {
  const result = inspectBashCommand("grep -r foo ~", CWD);
  assert.equal(result, "~");
});

test("blocked: compound command with dangerous segment", () => {
  const result = inspectBashCommand("echo hi && grep -r foo /", CWD);
  assert.equal(result, "/");
});

test("blocked: piped command with dangerous segment", () => {
  const result = inspectBashCommand("cat file | grep pattern /home", CWD);
  assert.equal(result, "/home");
});

test("blocked: fd targeting /usr", () => {
  assert.equal(inspectBashCommand("fd pattern /usr", CWD), "/usr");
});

test("blocked: grep with -- separator then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep pattern -- /", CWD), "/");
});

test("blocked: grep targeting dirname(homedir)", () => {
  const parentHome = dirname(homedir());
  const result = inspectBashCommand(`grep -r foo ${parentHome}`, CWD);
  assert.equal(result, parentHome);
});
