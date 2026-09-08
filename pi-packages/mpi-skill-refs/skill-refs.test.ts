import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import skillRefsExtension from "./index.js";
import {
  buildSkillBlock,
  createSkillCompletionWrapper,
  extractSkillRefs,
  scanSkillDirs,
  type ResolvedSkillRef,
} from "./skill-core.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-refs-test-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSkill(baseDir: string, name: string, description: string): string {
  const skillDir = path.join(baseDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.\n`,
  );
  return file;
}

/** Minimal fake ExtensionAPI capturing handlers and sent messages. */
function createFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const autocompleteFactories: Array<(base: unknown) => unknown> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      sent.push({ message, options });
    },
  };
  const ctx = {
    cwd: "/nonexistent-project",
    ui: {
      addAutocompleteProvider(factory: (base: unknown) => unknown) {
        autocompleteFactories.push(factory);
      },
    },
  };
  return { pi, ctx, handlers, sent, autocompleteFactories };
}

function authoritativeSkill(name: string, filePath = `/skills/${name}/SKILL.md`) {
  return { name, description: `${name} description`, filePath, baseDir: path.join(filePath, "..") };
}

async function emitBeforeAgentStart(
  fake: ReturnType<typeof createFakePi>,
  prompt: string,
  skills: unknown[],
): Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined> {
  const handler = fake.handlers.get("before_agent_start");
  assert.ok(handler, "before_agent_start handler registered");
  return (await handler(
    { type: "before_agent_start", prompt, systemPromptOptions: { cwd: "/p", skills } },
    fake.ctx,
  )) as { message?: { customType: string; content: string; display: boolean } } | undefined;
}

// ─── extractSkillRefs ────────────────────────────────────────────────────────

test("extractSkillRefs: extracts and dedupes in order", () => {
  assert.deepEqual(extractSkillRefs("use $review then $audit then $review"), ["review", "audit"]);
});

test("extractSkillRefs: ignores common environment variables", () => {
  assert.deepEqual(extractSkillRefs("echo $PATH $HOME $review $Path"), ["review"]);
});

test("extractSkillRefs: ignores refs inside fenced code blocks", () => {
  const text = "run $review\n```bash\necho $lint\n```\nand $audit";
  assert.deepEqual(extractSkillRefs(text), ["review", "audit"]);
});

test("extractSkillRefs: requires a boundary before the dollar", () => {
  assert.deepEqual(extractSkillRefs("foo$bar path/$baz a.$qux ($ok)"), ["ok"]);
});

test("extractSkillRefs: names must start with a letter", () => {
  assert.deepEqual(extractSkillRefs("$1abc $_x $ok-name $with:colon"), ["ok-name", "with:colon"]);
});

test("extractSkillRefs: returns nothing for shell mode input", () => {
  assert.deepEqual(extractSkillRefs("!echo $review"), []);
  assert.deepEqual(extractSkillRefs("!!secret $review"), []);
  // Leading whitespace/newline still routes to the shell (parseInput parity),
  // and $tokens on later lines of a !-prefixed input are shell variables.
  assert.deepEqual(extractSkillRefs("  \n!multi $review\n$audit"), []);
});

// ─── buildSkillBlock ─────────────────────────────────────────────────────────

test("buildSkillBlock: renders instruction and skill XML", () => {
  const skills: ResolvedSkillRef[] = [
    {
      name: "review",
      filePath: "/s/review/SKILL.md",
      baseDir: "/s/review",
      description: "Review <code> & stuff",
    },
  ];
  const block = buildSkillBlock(skills);
  assert.match(block, /explicitly invoked the following skills/);
  assert.match(block, /<skill name="review">/);
  assert.match(block, /<location>\/s\/review\/SKILL\.md<\/location>/);
  assert.match(block, /<base>\/s\/review<\/base>/);
  // XML escaping of description
  assert.match(block, /Review &lt;code&gt; &amp; stuff/);
});

// ─── scanSkillDirs ───────────────────────────────────────────────────────────

test("scanSkillDirs: finds flat and nested skills across dirs", async () => {
  const project = makeTempDir();
  const home = makeTempDir();
  writeSkill(path.join(project, ".agents", "skills"), "flat-skill", "Flat one.");
  // Nested layout: <dir>/<group>/<name>/SKILL.md
  writeSkill(path.join(home, ".agents", "skills", "group"), "nested-skill", "Nested one.");
  writeSkill(path.join(home, ".pi", "agent", "skills"), "home-skill", "Home one.");

  const entries = await scanSkillDirs(project, home);
  const names = [...entries.keys()].sort();
  assert.deepEqual(names, ["flat-skill", "home-skill", "nested-skill"]);
  const flat = entries.get("flat-skill")!;
  assert.equal(flat.description, "Flat one.");
  assert.ok(flat.filePath?.endsWith("SKILL.md"));
});

test("scanSkillDirs: project dir takes precedence over home for duplicates", async () => {
  const project = makeTempDir();
  const home = makeTempDir();
  writeSkill(path.join(project, ".agents", "skills"), "dup", "From project.");
  writeSkill(path.join(home, ".agents", "skills"), "dup", "From home.");
  const entries = await scanSkillDirs(project, home);
  assert.equal(entries.get("dup")?.description, "From project.");
});

test("scanSkillDirs: finds npm, git, and extension package skills", async () => {
  const project = makeTempDir();
  const home = makeTempDir();
  const agentDir = path.join(home, ".pi", "agent");
  writeSkill(
    path.join(agentDir, "npm", "node_modules", "plain-pkg", "skills"),
    "plain-pkg-skill",
    "From plain npm package.",
  );
  writeSkill(
    path.join(agentDir, "npm", "node_modules", "@scope", "scoped-pkg", "skills"),
    "scoped-pkg-skill",
    "From scoped npm package.",
  );
  writeSkill(
    path.join(agentDir, "git", "github.com", "org", "repo", "skills"),
    "git-pkg-skill",
    "From git package.",
  );

  writeSkill(
    path.join(agentDir, "extensions", "builtin-pkg", "skills"),
    "builtin-pkg-skill",
    "From built-in package.",
  );
  const entries = await scanSkillDirs(project, home, agentDir);
  assert.equal(entries.get("plain-pkg-skill")?.description, "From plain npm package.");
  assert.equal(entries.get("scoped-pkg-skill")?.description, "From scoped npm package.");
  assert.equal(entries.get("git-pkg-skill")?.description, "From git package.");
  assert.equal(entries.get("builtin-pkg-skill")?.description, "From built-in package.");
  assert.ok(entries.get("scoped-pkg-skill")?.filePath?.includes("@scope/scoped-pkg"));
});

test("scanSkillDirs: user skills take precedence over package skills", async () => {
  const project = makeTempDir();
  const home = makeTempDir();
  const agentDir = path.join(home, ".pi", "agent");
  writeSkill(path.join(agentDir, "skills"), "dup", "From user agent skills.");
  writeSkill(path.join(agentDir, "npm", "node_modules", "pkg", "skills"), "dup", "From package.");
  const entries = await scanSkillDirs(project, home, agentDir);
  assert.equal(entries.get("dup")?.description, "From user agent skills.");
});

test("scanSkillDirs: project-only mode excludes global and package skills", async () => {
  const project = makeTempDir();
  const home = makeTempDir();
  const agentDir = path.join(home, ".pi", "agent");
  writeSkill(path.join(project, ".agents", "skills"), "project-skill", "From project.");
  writeSkill(
    path.join(agentDir, "extensions", "builtin-pkg", "skills"),
    "builtin-skill",
    "From built-in package.",
  );
  const entries = await scanSkillDirs(project, home, agentDir, {
    MIXCODE_PROJECT_SKILLS_ONLY: "1",
  });
  assert.deepEqual([...entries.keys()], ["project-skill"]);
});

// ─── before_agent_start expansion ────────────────────────────────────────────

test("before_agent_start: injects hidden custom message for $refs", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "please $review this diff", [
    authoritativeSkill("review"),
  ]);
  assert.ok(result?.message);
  assert.equal(result.message.customType, "skill-refs");
  assert.equal(result.message.display, false);
  assert.match(result.message.content, /<skill name="review">/);
  assert.match(result.message.content, /<location>\/skills\/review\/SKILL\.md<\/location>/);
});

test("before_agent_start: returns nothing when prompt has no refs", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "no refs here", [authoritativeSkill("review")]);
  assert.equal(result, undefined);
});

test("before_agent_start: unknown refs are silently skipped", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "run $nonexistent now", [
    authoritativeSkill("review"),
  ]);
  assert.equal(result, undefined);
});

test("before_agent_start: shell mode prompt injects nothing", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "!echo $review", [authoritativeSkill("review")]);
  assert.equal(result, undefined);
});

test("before_agent_start: mixes known and unknown refs, keeping known", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "$review and $ghost", [
    authoritativeSkill("review"),
  ]);
  assert.ok(result?.message);
  assert.match(result.message.content, /<skill name="review">/);
  assert.doesNotMatch(result.message.content, /ghost/);
});

// ─── context expansion for delivered queued messages ───────────────────────

async function projectContext(
  fake: ReturnType<typeof createFakePi>,
  messages: AgentMessage[],
): Promise<AgentMessage[]> {
  const handler = fake.handlers.get("context")!;
  const result = (await handler({ type: "context", messages }, fake.ctx)) as
    | { messages: AgentMessage[] }
    | undefined;
  return result?.messages ?? messages;
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

test("context: delivered $ref gains hidden instructions without changing user history", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);
  const input = [userMessage("also apply $review")];
  const result = await projectContext(fake, input);
  assert.deepEqual(input, [userMessage("also apply $review")]);
  assert.deepEqual(result[0], input[0]);
  const block = result[1];
  assert.ok(block?.role === "custom");
  assert.equal(block.customType, "skill-refs");
  assert.equal(block.display, false);
  assert.match(String(block.content), /<skill name="review">/);
  assert.equal(fake.sent.length, 0);
});

test("context: each delivered skill prompt retains its own instructions", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [
    authoritativeSkill("review"),
    authoritativeSkill("audit"),
  ]);
  const result = await projectContext(fake, [userMessage("$review"), userMessage("then $audit")]);
  assert.deepEqual(
    result.map((message) => message.role),
    ["user", "custom", "user", "custom"],
  );
  const review = result[1];
  const audit = result[3];
  assert.ok(review?.role === "custom");
  assert.ok(audit?.role === "custom");
  assert.match(String(review.content), /<skill name="review">/);
  assert.match(String(audit.content), /<skill name="audit">/);
});

test("context: idle and replayed skill blocks are not duplicated", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const idle = await emitBeforeAgentStart(fake, "$review", [authoritativeSkill("review")]);
  assert.ok(idle?.message);
  const input: AgentMessage[] = [
    userMessage("$review"),
    { role: "custom", ...idle.message, timestamp: 1 },
  ];
  assert.deepEqual(await projectContext(fake, input), input);
});

test("context: repeated projections and repeated references do not duplicate blocks", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);
  const input = [userMessage("$review"), userMessage("again $review")];
  const first = await projectContext(fake, input);
  assert.deepEqual(
    first.map((message) => message.role),
    ["user", "custom", "user"],
  );
  assert.deepEqual(await projectContext(fake, first), first);
  assert.deepEqual(await projectContext(fake, input), first);
});

test("context: plain text and unknown references gain no instructions", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);
  const input = [userMessage("no refs"), userMessage("$unknown")];
  assert.deepEqual(await projectContext(fake, input), input);
});

test("context: shell input and unrelated custom messages do not invoke skills", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);
  const input: AgentMessage[] = [
    userMessage("!echo $review"),
    { role: "custom", customType: "notification", content: "$review", display: true, timestamp: 1 },
  ];
  assert.deepEqual(await projectContext(fake, input), input);
});

// ─── session_start cold-start scan + autocomplete registration ──────────────

test("session_start: scans filesystem and registers $ autocomplete", async () => {
  const project = makeTempDir();
  writeSkill(path.join(project, ".agents", "skills"), "cold-skill", "Cold start skill.");

  const fake = createFakePi();
  (fake.ctx as { cwd: string }).cwd = project;
  skillRefsExtension(fake.pi as never);

  const sessionStart = fake.handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler registered");
  await sessionStart({ type: "session_start", reason: "startup" }, fake.ctx);

  assert.equal(fake.autocompleteFactories.length, 1);
  const base = {
    triggerCharacters: ["/"],
    getSuggestions: async () => null,
    applyCompletion: () => ({ lines: [""], cursorLine: 0, cursorCol: 0 }),
  };
  const provider = fake.autocompleteFactories[0]!(base) as {
    triggerCharacters?: string[];
    getSuggestions: (
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal },
    ) => Promise<{ prefix: string; items: Array<{ value: string; label: string }> } | null>;
  };
  assert.ok(provider.triggerCharacters?.includes("$"));
  assert.ok(provider.triggerCharacters?.includes("/"));

  const suggestions = await provider.getSuggestions(["$cold"], 0, 5, {
    signal: new AbortController().signal,
  });
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "$cold");
  assert.equal(suggestions.items[0]?.value, "$cold-skill");
});

test("session_start: re-registering autocomplete is guarded per instance", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const sessionStart = fake.handlers.get("session_start")!;
  await sessionStart({ type: "session_start", reason: "startup" }, fake.ctx);
  await sessionStart({ type: "session_start", reason: "reload" }, fake.ctx);
  assert.equal(fake.autocompleteFactories.length, 1);
});

// ─── autocomplete wrapper behavior ───────────────────────────────────────────

test("completion wrapper: $ token suggests skills, fuzzy filtered", async () => {
  const provider = createSkillCompletionWrapper(
    {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    },
    () => [
      { name: "review", description: "Review things" },
      { name: "audit", description: "Audit things" },
    ],
  );
  const suggestions = await provider.getSuggestions(["do $rev"], 0, 7, {
    signal: new AbortController().signal,
  });
  assert.ok(suggestions);
  assert.equal(suggestions.items.length, 1);
  assert.equal(suggestions.items[0]!.value, "$review");
  assert.match(suggestions.items[0]!.description ?? "", /Review things/);
});

test("completion wrapper: bare $ lists all skills", async () => {
  const provider = createSkillCompletionWrapper(
    {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    },
    () => [{ name: "review" }, { name: "audit" }],
  );
  const suggestions = await provider.getSuggestions(["$"], 0, 1, {
    signal: new AbortController().signal,
  });
  assert.equal(suggestions?.items.length, 2);
});

test("completion wrapper: non-$ tokens delegate to base", async () => {
  let delegated = false;
  const provider = createSkillCompletionWrapper(
    {
      getSuggestions: async () => {
        delegated = true;
        return null;
      },
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    },
    () => [{ name: "review" }],
  );
  await provider.getSuggestions(["@file"], 0, 5, { signal: new AbortController().signal });
  assert.equal(delegated, true);
});

test("completion wrapper: applyCompletion replaces the whole $ token", () => {
  const provider = createSkillCompletionWrapper(
    {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    },
    () => [{ name: "review" }],
  );
  const result = provider.applyCompletion(
    ["do $rev now"],
    0,
    7,
    { value: "$review", label: "review" },
    "$rev",
  );
  assert.equal(result.lines[0], "do $review now");
  assert.equal(result.cursorCol, 10);
});

test("completion wrapper: shouldTriggerFileCompletion true for $ token", () => {
  const provider = createSkillCompletionWrapper(
    {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    },
    () => [],
  );
  assert.equal(provider.shouldTriggerFileCompletion?.(["$re"], 0, 3), true);
  // Pi: base without shouldTriggerFileCompletion means allow (not false).
  assert.equal(provider.shouldTriggerFileCompletion?.(["plain"], 0, 5), true);

  const strictBase = createSkillCompletionWrapper(
    {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
      shouldTriggerFileCompletion: () => false,
    },
    () => [],
  );
  assert.equal(strictBase.shouldTriggerFileCompletion?.(["$re"], 0, 3), true);
  assert.equal(strictBase.shouldTriggerFileCompletion?.(["plain"], 0, 5), false);
});

test("completion wrapper: shell mode input delegates to base (no $ skill items)", async () => {
  let delegated = false;
  const strictBase = createSkillCompletionWrapper(
    {
      getSuggestions: async () => {
        delegated = true;
        return null;
      },
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
      shouldTriggerFileCompletion: () => false,
    },
    () => [{ name: "review", description: "Review things" }],
  );
  // Shell mode is a whole-input property: a $token on any later line is a
  // shell variable and must not produce skill suggestions.
  const suggestions = await strictBase.getSuggestions(["!for f in *; do", "  echo $rev"], 1, 11, {
    signal: new AbortController().signal,
  });
  assert.equal(delegated, true);
  assert.equal(suggestions, null);
  assert.equal(strictBase.shouldTriggerFileCompletion?.(["!echo $rev"], 0, 9), false);
  // Non-shell text keeps $-trigger behavior.
  assert.equal(strictBase.shouldTriggerFileCompletion?.(["echo $rev"], 0, 8), true);
});

// ─── authoritative refresh replaces stale entries ────────────────────────────

test("before_agent_start: refresh replaces authoritative list", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm", [authoritativeSkill("old-skill")]);
  // Second turn: old-skill removed, new-skill added.
  const result = await emitBeforeAgentStart(fake, "$old-skill $new-skill", [
    authoritativeSkill("new-skill"),
  ]);
  assert.ok(result?.message);
  assert.match(result.message.content, /<skill name="new-skill">/);
  assert.doesNotMatch(result.message.content, /<skill name="old-skill">/);
});
