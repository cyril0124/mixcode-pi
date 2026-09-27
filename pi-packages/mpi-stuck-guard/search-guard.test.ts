import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectBashCommand, tokenize, wireSearchGuard } from "./search-guard.js";

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

test("blocked: rg regex alternation in quotes targeting /", () => {
  // The pipe inside quotes must not be treated as a shell pipe.
  assert.equal(inspectBashCommand("rg 'foo|bar' /", CWD), "/");
});

test("blocked: grep -E quoted alternation targeting ~", () => {
  assert.equal(inspectBashCommand("grep -E 'x|y' ~", CWD), "~");
});

test("blocked: quoted semicolon in pattern targeting /", () => {
  assert.equal(inspectBashCommand('rg "a;b" /', CWD), "/");
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

// ─── implicit search root after an in-command cd ──────────────────────────────

test("blocked: unqualified fd after cd into home", () => {
  const cmd = `cd ${HOME} && fd -t f foo -d 8 2>/dev/null | head`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("blocked: unqualified fd with alternation pattern after cd into home", () => {
  const cmd = `cd ${HOME} && fd -t d -i 'foo|bar' -d 8 2>/dev/null | head`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("blocked: unqualified rg after cd $HOME", () => {
  assert.equal(inspectBashCommand("cd $HOME && rg foo", CWD), HOME);
});

test("blocked: cd reaching parent(homedir) in two steps", () => {
  const cmd = `cd ${PARENT_HOME} && cd ${path.basename(HOME)} && rg foo`;
  assert.equal(inspectBashCommand(cmd, CWD), HOME);
});

test("blocked: recursive grep with no path after cd into home", () => {
  assert.equal(inspectBashCommand(`cd ${HOME} && grep -rn foo`, CWD), HOME);
});

test("blocked: bare find after cd into home", () => {
  assert.equal(inspectBashCommand(`cd ${HOME} && find -name '*.log'`, CWD), HOME);
});

test("safe: unqualified rg without any cd", () => {
  assert.equal(inspectBashCommand("rg foo", CWD), null);
});

test("safe: unqualified fd without any cd", () => {
  assert.equal(inspectBashCommand("fd -t f foo -d 8", CWD), null);
});

test("safe: unqualified rg after cd into a subdirectory of home", () => {
  assert.equal(inspectBashCommand(`cd ${HOME}/project && rg foo`, CWD), null);
});

test("safe: piped search after cd into home reads stdin", () => {
  assert.equal(inspectBashCommand(`cd ${HOME} && cat log.txt | rg foo`, CWD), null);
});

test("safe: non-recursive grep after cd into home reads stdin", () => {
  assert.equal(inspectBashCommand(`cd ${HOME} && grep foo`, CWD), null);
});

test("safe: here-string search after cd into home reads stdin", () => {
  assert.equal(inspectBashCommand(`cd ${HOME} && rg foo <<< "text"`, CWD), null);
});

test("safe: unresolvable cd target is not tracked", () => {
  assert.equal(inspectBashCommand('cd "$SOME_DIR" && rg foo', CWD), null);
});

test("safe: cd - is not tracked", () => {
  assert.equal(inspectBashCommand("cd - && rg foo", CWD), null);
});

// ─── false-positive sweep: legitimate searches must stay allowed ──────────────

const ALLOWED_COMMANDS: Array<[string, string]> = [
  ["plain rg with no path", "rg foo"],
  ["rg with explicit project path", "rg -n foo src/core"],
  ["rg with quoted alternation pattern", "rg -e 'a|b' ."],
  ["rg with quoted semicolon pattern", 'rg "a;b" src'],
  ["rg with glob flag", "rg -g '*.ts' foo src"],
  ["rg --files piped", "rg --files | head"],
  ["rg with pattern file flag", "rg -f patterns.txt src"],
  ["rg with type-add", "rg --type-add 'x:*.x' -t x foo src"],
  ["rg with output redirection", "rg foo > /tmp/out"],
  ["rg with stderr redirection", "rg foo 2>/dev/null"],
  ["fd with extension filter", "fd -e ts foo -d 3"],
  ["fd with hidden and type flags", "fd -H -t f foo"],
  ["fd with exclude", "fd --type f --exclude node_modules foo"],
  ["fd with explicit project path", "fd -t f -d 2 foo src"],
  ["grep recursive in project", "grep -rn foo src"],
  ["grep reading stdin", "grep foo"],
  ["grep count in file", "grep -c foo file.txt"],
  ["grep with context flags", "grep -A 3 -B 2 foo src"],
  ["grep with include flag", "grep --include='*.ts' -r foo src"],
  ["find in project", "find . -name '*.ts'"],
  ["find with maxdepth", "find ./src -maxdepth 3 -type f"],
  ["find with exec", "find src -name '*.ts' -exec rg foo {} ;"],
  ["non-search command on /etc", "ls -la /etc"],
  ["pipe to pager", "cat README.md | head -20"],
  ["pipe into rg", "cat log.txt | rg -n error"],
  ["stdin redirect into rg", "rg -n error < log.txt"],
  ["here-string into rg", 'rg foo <<< "x"'],
  ["du then search", "du -sh /tmp && rg foo"],
  ["file whose name starts with cd", "cat cd-notes.md"],
  ["cd as search pattern", "rg -w cd src"],
  ["echo cd", "echo cd"],
  ["mkdir path containing cd", "mkdir -p a/cd && rg foo"],
  ["echo quoted cd path", `echo "cd ${HOME}" && rg foo`],
  ["quoted cd path as pattern", "rg 'cd /project/myapp'"],
  ["printf cd then search", "printf '%s' cd && rg foo"],
  ["cd into project subdirectory", "cd src && rg foo"],
  ["cd to project root", "cd /project && rg foo"],
  ["cd .. within project", "cd .. && rg foo"],
  ["cd . then search", "cd . && rg foo"],
  ["cd ./src then search", "cd ./src && rg foo"],
  ["cd via command substitution", "cd $(git rev-parse --show-toplevel) && rg foo"],
  ["cd via backticks", "cd `pwd` && rg foo"],
  ["cd $VAR unresolvable", 'cd "$SOME_DIR" && rg foo'],
  ["cd - unresolvable", "cd - && rg foo"],
  ["cd ~user unresolvable", "cd ~user/x && rg foo"],
  ["cd glob target unresolvable", `cd ${PARENT_HOME}/* && rg foo`],
  ["git -C then search", "git -C . status && rg foo"],
  ["env prefix search", "env rg foo"],
  ["sudo prefix search", "sudo rg foo"],
  ["inline comment", "echo ok # rg foo /"],
  ["pipe to tail", "npm test 2>&1 | tail -20"],
  ["cd blacklisted but piped search", `cd ${HOME} && cat log.txt | rg foo`],
  ["cd blacklisted but non-recursive grep", `cd ${HOME} && grep foo`],
  ["cd blacklisted then safe explicit path", "cd /tmp && rg foo /project"],
  ["cd out of blacklisted back into project", "cd /tmp/x && cd /project/myapp && rg foo"],
  ["cd home subdirectory", `cd ${HOME}/project && rg foo`],
  ["explicit home subdirectory path", "rg foo ~/project"],
  ["search before cd to blacklisted dir", `rg foo src && cd ${HOME}`],
  ["multiline cd project then search", "cd /project/myapp\nrg foo"],
  ["cd into then out of blacklisted dir", "cd /tmp; cd /project/myapp; rg foo"],
  ["subshell in project then search", "(cd /project/myapp && rg foo)"],
  ["command substitution in project", "echo $(cd /project/myapp && rg foo)"],
  ["assignment before cd into project", "FOO=1 cd /project/myapp && rg foo"],
  ["cd -P into project", "cd -P /project/myapp && rg foo"],
  ["search then pipe then cd project", "rg foo | grep -v x && cd /project/myapp && rg bar"],
  ["rg then logical or", "rg foo || rg bar"],
];

for (const [label, cmd] of ALLOWED_COMMANDS) {
  test(`safe sweep: ${label}`, () => {
    assert.equal(inspectBashCommand(cmd, CWD), null, `unexpected block: ${cmd}`);
  });
}

// ─── regression sweep: newly covered blocks must stay blocked ─────────────────

const BLOCKED_COMMANDS: Array<[string, string]> = [
  ["cd home then fd piped to head", `cd ${HOME} && fd foo | head`],
  ["cd home then sudo rg", `cd ${HOME} && sudo rg foo --glob '*.ts'`],
  ["cd home then grep -ir", `cd ${HOME} && grep -ir foo`],
  ["cd home then grep -r", `cd ${HOME} && grep -r foo`],
  ["assignment before cd into home", `FOO=1 cd ${HOME} && rg foo`],
  ["cd home then cd home/..", `cd ${HOME} && cd ${HOME}/.. && rg foo`],
  ["search, cd home, search again", `rg foo src && cd ${HOME} && fd bar`],
  ["pipe chain then cd tmp then search", "rg foo | grep -v x && cd /tmp && rg bar"],
  ["cd /nfs then rg", "cd /nfs && rg foo"],
  ["cd /var then rg", "cd /var && rg foo"],
  ["cd /opt then rg", "cd /opt && rg foo"],
  ["cd ../../.. reaches root", "cd ../../.. && rg foo"],
  ["cd ~ then recursive grep", "cd ~ && grep -rn foo"],
  ["cd ~/ then fd", "cd ~/ && fd -t d foo"],
  ["cd quoted $HOME then rg", 'cd "$HOME" && rg foo'],
  [`cd braced ${BRACED_HOME} then rg`, `cd ${BRACED_HOME} && rg foo`],
  ["cd trailing slash home then rg", `cd ${HOME}/ && rg foo`],
  ["cd home/spurious/.. then rg", `cd ${HOME}/sub/.. && rg foo`],
  ["cd shuffled home components then rg", `cd ${PARENT_HOME}//${path.basename(HOME)} && rg foo`],
  ["newline cd home then rg", `cd ${HOME}\nrg foo`],
  [
    "multiline unqualified fd after cd into home",
    `cd ${HOME} && fd -t f 'a' -d 8 2>/dev/null | head; echo x; fd -t f 'b' -d 8 2>/dev/null | head`,
  ],
];

for (const [label, cmd] of BLOCKED_COMMANDS) {
  test(`blocked sweep: ${label}`, () => {
    assert.notEqual(inspectBashCommand(cmd, CWD), null, `unexpected allow: ${cmd}`);
  });
}

// ─── tool_call wiring ────────────────────────────────────────────────────────

interface GuardVerdict {
  block?: boolean;
  reason?: string;
}

type ToolCallHandler = (event: unknown, ctx: unknown) => GuardVerdict | undefined;

/** Capture the `tool_call` handler that wireSearchGuard registers with the harness. */
function wireGuard(): ToolCallHandler {
  const handlers = new Map<string, ToolCallHandler>();
  const pi = {
    on: (name: string, fn: ToolCallHandler) => {
      handlers.set(name, fn);
    },
  } as unknown as ExtensionAPI;
  wireSearchGuard(pi);
  const handler = handlers.get("tool_call");
  if (!handler) throw new Error("wireSearchGuard must register a tool_call handler");
  return handler;
}

const guard = wireGuard();

test("wiring: blocks a bash search after cd into home and names the path", () => {
  const command = `cd ${HOME} && fd -t f foo -d 8 2>/dev/null | head`;
  const verdict = guard({ toolName: "bash", input: { command } }, { cwd: CWD });
  assert.equal(verdict?.block, true);
  assert.match(verdict?.reason ?? "", /^\[search-guard\] Blocked: bash on /);
});

test("wiring: allows a bash search confined to the project", () => {
  const verdict = guard({ toolName: "bash", input: { command: "rg -n foo src" } }, { cwd: CWD });
  assert.equal(verdict, undefined);
});

test("wiring: blocks the grep tool rooted at a blacklisted path", () => {
  const verdict = guard({ toolName: "grep", input: { path: HOME } }, { cwd: CWD });
  assert.equal(verdict?.block, true);
  assert.match(verdict?.reason ?? "", /^\[search-guard\] Blocked: grep on /);
});

test("wiring: allows the grep tool with an in-project path", () => {
  const verdict = guard({ toolName: "grep", input: { path: "src" } }, { cwd: CWD });
  assert.equal(verdict, undefined);
});

test("wiring: blocks the find tool whose default path resolves into a blacklisted cwd", () => {
  const verdict = guard({ toolName: "find", input: {} }, { cwd: HOME });
  assert.equal(verdict?.block, true);
});

test("wiring: allows the find tool whose default path resolves into the project", () => {
  const verdict = guard({ toolName: "find", input: {} }, { cwd: CWD });
  assert.equal(verdict, undefined);
});

test("wiring: ignores unrelated tools", () => {
  const verdict = guard({ toolName: "read", input: { path: "/etc/passwd" } }, { cwd: CWD });
  assert.equal(verdict, undefined);
});

// ─── depth-bounded searches are cheap whatever the root ──────────────────────

const SHALLOW_COMMANDS: Array<[string, string]> = [
  ["fd -d 1 in home", `cd ${HOME} && fd -t f -d 1 | head -20`],
  ["fd -d 2 in home", `cd ${HOME} && fd -t f -d 2`],
  ["fd attached -d1 in home", "cd ~ && fd -t f -d1"],
  ["fd --max-depth=1 in home", "cd ~ && fd -t f --max-depth=1"],
  ["fd --max-depth 2 in home", "cd ~ && fd -t f --max-depth 2"],
  ["rg --max-depth 1 in home", "cd ~ && rg --max-depth 1 foo"],
  ["find -maxdepth 1 in home", `cd ${HOME} && find -maxdepth 1 -type f`],
  ["find -maxdepth 2 in home", `cd ${HOME} && find -maxdepth 2 -type f`],
  ["fd -d 1 on a blacklisted root", "fd -t f -d 1 /"],
  ["find -maxdepth 1 on a blacklisted root", "find /tmp -maxdepth 1 -type f"],
  ["rg --max-depth 2 on a blacklisted root", "rg --max-depth 2 foo /etc"],
];

for (const [label, cmd] of SHALLOW_COMMANDS) {
  test(`safe sweep: ${label}`, () => {
    assert.equal(inspectBashCommand(cmd, CWD), null, `unexpected block: ${cmd}`);
  });
}

const DEEP_COMMANDS: Array<[string, string]> = [
  ["fd -d 3 in home", `cd ${HOME} && fd -t f -d 3`],
  ["find -maxdepth 3 in home", `cd ${HOME} && find -maxdepth 3 -type f`],
  ["fd --max-depth 4 in home", "cd ~ && fd -t f --max-depth 4"],
  ["rg --max-depth 3 in home", "cd ~ && rg --max-depth 3 foo"],
  ["grep -d recurse in home is not a depth flag", `cd ${HOME} && grep -r -d recurse foo`],
];

for (const [label, cmd] of DEEP_COMMANDS) {
  test(`blocked sweep: ${label}`, () => {
    assert.notEqual(inspectBashCommand(cmd, CWD), null, `unexpected allow: ${cmd}`);
  });
}

// ─── ~user spelling of the current home ──────────────────────────────────────

const USER_NAME = process.env.USER || process.env.LOGNAME || os.userInfo().username;

test("blocked: tilde-user form of home as an implicit search root", () => {
  assert.equal(inspectBashCommand(`cd ~${USER_NAME} && fd -t f -d 8`, CWD), HOME);
});

test("blocked: tilde-user form of home as an explicit path", () => {
  assert.equal(inspectBashCommand(`fd -t f -d 8 ~${USER_NAME}`, CWD), `~${USER_NAME}`);
});

test("blocked: tilde-user with subdirectory is still blocked as a bare home root", () => {
  assert.equal(inspectBashCommand(`grep -r foo ~${USER_NAME}`, CWD), `~${USER_NAME}`);
});

test("safe: tilde-user of a subdirectory", () => {
  assert.equal(inspectBashCommand(`fd -t f -d 8 ~${USER_NAME}/project`, CWD), null);
});

test("safe: tilde-user of an unresolvable account", () => {
  assert.equal(inspectBashCommand("fd -t f -d 8 ~otheruser", CWD), null);
});
