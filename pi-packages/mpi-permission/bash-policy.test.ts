import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBashCommand } from "./bash-policy.js";

test("analyzeBashCommand: extracts static path arguments from file commands", () => {
  const result = analyzeBashCommand(
    "ls -la .. && cat ../secret.txt; find ../src -name '*.ts'; source ../env.sh; . ../profile",
  );
  assert.deepEqual(result.segments, [
    "ls -la ..",
    "cat ../secret.txt",
    "find ../src -name *.ts",
    "source ../env.sh",
    ". ../profile",
  ]);
  assert.deepEqual(
    result.pathArguments.sort(),
    ["*.ts", "..", "../secret.txt", "../src", "../env.sh", "../profile"].sort(),
  );
  assert.equal(result.dynamicPathArguments, false);
  assert.deepEqual(result.errors, []);
});

test("analyzeBashCommand: unwraps transparent command prefixes", () => {
  const result = analyzeBashCommand(
    "command ls ../one; builtin cat ../two; exec rm ../three; sudo -u root ls ../four",
  );
  assert.deepEqual(result.segments, ["ls ../one", "cat ../two", "rm ../three", "ls ../four"]);
  assert.deepEqual(result.pathArguments.sort(), ["../one", "../two", "../three", "../four"].sort());
});

test("analyzeBashCommand: extracts path-valued options before skipping flags", () => {
  const result = analyzeBashCommand(
    "cp --target-directory=../one file; mv -t ../two file; sudo --chdir ../three ls; env -C../four ls",
  );
  assert.deepEqual(
    result.pathArguments.filter((value) => value.startsWith("../")).sort(),
    ["../one", "../two", "../three", "../four"].sort(),
  );
});

test("analyzeBashCommand: marks dynamic path-valued options", () => {
  const result = analyzeBashCommand('cp --target-directory="$TARGET" file');
  assert.equal(result.dynamicPathArguments, true);
  assert.deepEqual(result.pathArguments, ["file"]);
});

test("analyzeBashCommand: parses env split-string and combined shell -c flags", () => {
  const result = analyzeBashCommand(
    "env -S 'ls ../one'; env -S 'ls' ../two; env -Sls ../three; env --split-string=ls ../four; bash -lc 'cat ../five'; sh -xc 'source ../six'",
  );
  assert.deepEqual(
    result.pathArguments.sort(),
    ["../one", "../two", "../three", "../four", "../five", "../six"].sort(),
  );
  assert.ok(result.segments.includes("ls ../one"));
  assert.ok(result.segments.includes("ls ../two"));
  assert.ok(result.segments.includes("ls ../three"));
  assert.ok(result.segments.includes("ls ../four"));
  assert.ok(result.segments.includes("cat ../five"));
  assert.ok(result.segments.includes("source ../six"));
});

test("analyzeBashCommand: treats dash-prefixed operands after -- as paths", () => {
  const result = analyzeBashCommand("cat -- -x/../../../etc/passwd");
  assert.deepEqual(result.pathArguments, ["-x/../../../etc/passwd"]);
});

test("analyzeBashCommand: scans deeply nested static shell scripts without a fail-open cutoff", () => {
  let command = "ls ../secret";
  for (let i = 0; i < 12; i++) command = `bash -c ${JSON.stringify(command)}`;
  const result = analyzeBashCommand(command);
  assert.ok(result.pathArguments.includes("../secret"));
  assert.deepEqual(result.errors, []);
});

test("analyzeBashCommand: traverses command expansions and nested shell scripts", () => {
  const result = analyzeBashCommand("echo $(cat ../one); bash -c 'ls ../two'");
  assert.deepEqual(result.segments, [
    "echo $(cat ../one)",
    "cat ../one",
    "bash -c ls ../two",
    "ls ../two",
  ]);
  assert.deepEqual(result.pathArguments.sort(), ["../one", "../two"].sort());
});

test("analyzeBashCommand: treats redirection targets as paths but not heredoc delimiters", () => {
  const result = analyzeBashCommand(
    "printf x > ../out; cat <<EOF\n../not-a-command\nEOF\n{ echo done; } > ../group-out",
  );
  assert.deepEqual(result.segments, ["printf x > ../out", "cat <<EOF", "echo done"]);
  assert.deepEqual(result.pathArguments.sort(), ["../out", "../group-out"].sort());
});

test("analyzeBashCommand: marks dynamic file arguments without guessing their value", () => {
  const result = analyzeBashCommand('cat "$TARGET"; ls "$(dirname ../x)"');
  assert.equal(result.dynamicPathArguments, true);
  assert.deepEqual(result.pathArguments, []);
  assert.ok(result.segments.includes("dirname ../x"));
});

test("analyzeBashCommand: does not infer paths inside arbitrary program source", () => {
  const result = analyzeBashCommand(`python -c 'open("../secret").read()'`);
  assert.deepEqual(result.pathArguments, []);
  assert.equal(result.dynamicPathArguments, false);
});

// ─── regression: traversal gaps found in commit-stage review ────────────────

test("analyzeBashCommand: traverses command substitutions inside arithmetic expansions", () => {
  const result = analyzeBashCommand(
    "echo $(( $(cat ../secret) + 1 )); (( $(cat ../a) )); a[$(( $(cat ../c) ))]=1",
  );
  assert.deepEqual(result.pathArguments.sort(), ["../a", "../c", "../secret"].sort());
  assert.equal(result.dynamicPathArguments, false);
});

test("analyzeBashCommand: traverses c-style for arithmetic command substitutions", () => {
  const result = analyzeBashCommand("for ((i=0; i<$(cat ../g); i++)); do :; done");
  assert.deepEqual(result.pathArguments, ["../g"]);
});

test("analyzeBashCommand: scans eval as a nested script", () => {
  const result = analyzeBashCommand("eval 'cat ../x'");
  assert.deepEqual(result.pathArguments, ["../x"]);
});

test("analyzeBashCommand: scans stdin-fed shell heredoc scripts and here-strings", () => {
  const stdin = analyzeBashCommand("bash -s <<'EOF'\ncat ../x\nEOF");
  assert.deepEqual(stdin.pathArguments, ["../x"]);
  const body = analyzeBashCommand("cat <<EOF\n$(cat ../f)\nEOF");
  assert.deepEqual(body.pathArguments, ["../f"]);
  const hereString = analyzeBashCommand("cat <<< $(cat ../g)");
  assert.deepEqual(hereString.pathArguments, ["../g"]);
});

test("analyzeBashCommand: traverses assignment, wordlist, case, and array words", () => {
  const result = analyzeBashCommand(
    "x=$(cat ../a); echo hi; for f in $(cat ../b); do :; done; case $(cat ../c) in x) ;; esac; a=( $(cat ../p) )",
  );
  assert.deepEqual(result.pathArguments.sort(), ["../a", "../b", "../c", "../p"].sort());
});

test("analyzeBashCommand: finds env -S split strings behind wrapper chains", () => {
  const result = analyzeBashCommand("sudo -u root env -S 'cat ../e'");
  assert.deepEqual(result.pathArguments, ["../e"]);
});

test("analyzeBashCommand: bounds nested env -S recursion and fails closed", () => {
  const result = analyzeBashCommand("env -S ".repeat(1000) + "cat ../x");
  assert.equal(result.dynamicPathArguments, true);
  assert.ok(result.errors.length > 0, "depth limit must surface an error, not truncate silently");
});

test("analyzeBashCommand: skips chmod mode operands as paths", () => {
  const result = analyzeBashCommand("chmod 755 ../l; chmod u+x ../m");
  assert.deepEqual(result.pathArguments.sort(), ["../l", "../m"].sort());
});

test("analyzeBashCommand: trims trailing whitespace folded into segments", () => {
  const result = analyzeBashCommand("echo hi '");
  assert.ok(result.segments.includes("echo hi"));
});
