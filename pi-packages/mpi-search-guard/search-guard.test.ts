import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { inspectBashCommand, tokenize } from "./index.js";

const CWD = "/project/myapp";
const HOME = os.homedir();
const PARENT_HOME = path.dirname(HOME);

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

test("safe: find in a subdirectory of home", () => {
  assert.equal(inspectBashCommand(`find ${HOME}/project -name '*.ts'`, CWD), null);
});

test("safe: comment-only line", () => {
  assert.equal(inspectBashCommand("# find / -name foo", CWD), null);
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
  assert.equal(inspectBashCommand("grep -r foo ~", CWD), "~");
});

test("blocked: compound command with dangerous segment", () => {
  assert.equal(inspectBashCommand("echo hi && grep -r foo /", CWD), "/");
});

test("blocked: piped command with dangerous segment", () => {
  assert.equal(inspectBashCommand("cat file | grep pattern /home", CWD), "/home");
});

test("blocked: fd targeting /usr", () => {
  assert.equal(inspectBashCommand("fd pattern /usr", CWD), "/usr");
});

test("blocked: grep with -- separator then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep pattern -- /", CWD), "/");
});

test("blocked: grep -e pattern then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep -e foo /", CWD), "/");
});

test("blocked: grep attached -ePATTERN then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep -eFOO /", CWD), "/");
});

test("blocked: grep attached -fFILE then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep -fpatterns.txt /home", CWD), "/home");
});

test("blocked: rg --regexp=pattern then blacklisted path", () => {
  assert.equal(inspectBashCommand("rg --regexp=pattern /", CWD), "/");
});

test("blocked: grep -f patterns file then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep -f patterns.txt /", CWD), "/");
});

test("blocked: rg -e pattern then blacklisted path", () => {
  assert.equal(inspectBashCommand("rg -e pattern /home", CWD), "/home");
});

test("blocked: grep -r -e pattern then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep -r -e pattern /", CWD), "/");
});

test("blocked: grep -E (ERE mode, no value) then blacklisted path", () => {
  assert.equal(inspectBashCommand("grep -E foo /", CWD), "/");
});

test("blocked: rg -g glob then sole blacklisted path (not misread as pattern)", () => {
  assert.equal(inspectBashCommand('rg -g "*.ts" /', CWD), "/");
});

test("blocked: rg -t type then sole blacklisted path", () => {
  assert.equal(inspectBashCommand("rg -t ts /home", CWD), "/home");
});

test("blocked: fd -e ext then sole blacklisted path", () => {
  assert.equal(inspectBashCommand("fd -e ts /", CWD), "/");
});

test("blocked: fd combined short flags then sole blacklisted path", () => {
  assert.equal(inspectBashCommand("fd -HIu /", CWD), "/");
});

test("blocked: bare rg with sole blacklisted path", () => {
  assert.equal(inspectBashCommand("rg /", CWD), "/");
});

test("safe: rg with pattern only (not a blacklisted root)", () => {
  assert.equal(inspectBashCommand("rg foo", CWD), null);
});

test("safe: grep -r with pattern then project path", () => {
  assert.equal(inspectBashCommand("grep -r foo src/", CWD), null);
});

test("blocked: grep targeting dirname(homedir)", () => {
  const result = inspectBashCommand(`grep -r foo ${PARENT_HOME}`, CWD);
  assert.equal(result, PARENT_HOME);
});

// ─── heredoc handling ─────────────────────────────────────────────────────────

test("blocked: find after heredoc with semicolons in body", () => {
  const cmd = `cat > /tmp/out.txt << 'EOF'
line one;
line two;
x = 1;
y = 2;
EOF
find ${HOME} -name "*.log" -type f 2>/dev/null | head -5`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("blocked: find after heredoc with cd prefix and comment", () => {
  const cmd = `cd /tmp/workdir && cat > /tmp/config.ini << 'HEREDOC'
[section]
key=value;
arr={1,2,3};
HEREDOC
# now search for something
find ${HOME} -name "target" -type f 2>/dev/null`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("safe: heredoc content not parsed as commands", () => {
  const cmd = `cat << EOF
find / -name foo
grep -r secret /home
rg dangerous /etc
EOF
echo done`;
  assert.equal(inspectBashCommand(cmd, CWD), null);
});

test("safe: heredoc with dash variant", () => {
  const cmd = `cat <<- MARKER
\tfind / -type f
\tgrep -r / /tmp
MARKER
echo ok`;
  assert.equal(inspectBashCommand(cmd, CWD), null);
});

// ─── comment handling ─────────────────────────────────────────────────────────

test("blocked: find after comment line", () => {
  const cmd = `# this is just a comment
find ${HOME} -name "*.ts"`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("safe: search command inside comment is ignored", () => {
  const cmd = `# find / -name foo
echo hello`;
  assert.equal(inspectBashCommand(cmd, CWD), null);
});

test("safe: inline comment after safe command", () => {
  assert.equal(inspectBashCommand("echo ok # find / -name x", CWD), null);
});

// ─── $HOME expansion ─────────────────────────────────────────────────────────

test("blocked: find targeting $HOME", () => {
  assert.equal(inspectBashCommand('find $HOME -name "target" -type f', CWD), "$HOME");
});

const BRACED_HOME = "$" + "{HOME}";

test(`blocked: grep targeting ${BRACED_HOME}`, () => {
  assert.equal(inspectBashCommand(`grep -r pattern \\${BRACED_HOME}`, CWD), BRACED_HOME);
});

test("safe: find targeting $HOME/subdir", () => {
  assert.equal(inspectBashCommand('find $HOME/projects -name "*.ts"', CWD), null);
});

// ─── redirections ─────────────────────────────────────────────────────────────

test("blocked: find with 2>/dev/null redirection", () => {
  assert.equal(inspectBashCommand(`find ${HOME} -name "x" -type f 2>/dev/null`, CWD), HOME);
});

test("safe: redirection tokens not confused as paths", () => {
  assert.equal(inspectBashCommand("grep -r foo src/ 2>/dev/null", CWD), null);
});

// ─── multiline combined scenarios ─────────────────────────────────────────────

test("blocked: multiline heredoc then dangerous find", () => {
  const cmd = `cd /tmp/work && cat > /tmp/input.cfg << 'END'
opt_a = true;
opt_b = false;
list = {a, b, c};
END
# locate the binary
find ${HOME} -name "mytool" -type f 2>/dev/null | head -3`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("blocked: find with multiple paths (second is dangerous)", () => {
  assert.equal(inspectBashCommand(`find ./safe ${HOME} -name "*.ts"`, CWD), HOME);
});

test("blocked: newline-separated dangerous command", () => {
  const cmd = `echo hello\nfind / -name foo`;
  assert.equal(inspectBashCommand(cmd, CWD), "/");
});
