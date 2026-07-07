import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import skillRefsExtension from "../pi-packages/skill-refs/index.ts";
import {
  buildSkillBlock,
  createSkillCompletionWrapper,
  extractSkillRefs,
  parseSkillDescription,
  scanSkillDirs,
  type ResolvedSkillRef,
} from "../pi-packages/skill-refs/skill-core.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-refs-test-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeSkill(baseDir: string, name: string, description: string): string {
  const skillDir = join(baseDir, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.\n`);
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
  return { name, description: `${name} description`, filePath, baseDir: join(filePath, "..") };
}

async function emitBeforeAgentStart(
  fake: ReturnType<typeof createFakePi>,
  prompt: string,
  skills: unknown[],
): Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined> {
  const handler = fake.handlers.get("before_agent_start");
  assert.ok(handler, "before_agent_start handler registered");
  return (await handler({ type: "before_agent_start", prompt, systemPromptOptions: { cwd: "/p", skills } }, fake.ctx)) as
    | { message?: { customType: string; content: string; display: boolean } }
    | undefined;
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

// ─── parseSkillDescription ───────────────────────────────────────────────────

test("parseSkillDescription: reads frontmatter description", () => {
  const content = "---\nname: x\ndescription: Does things well.\n---\n\nBody.";
  assert.equal(parseSkillDescription(content), "Does things well.");
});

test("parseSkillDescription: joins folded multi-line description", () => {
  const content = "---\ndescription: >-\n  Line one\n  and line two.\n---\nBody.";
  assert.equal(parseSkillDescription(content), "Line one and line two.");
});

test("parseSkillDescription: falls back to first paragraph", () => {
  const content = "# Title\n\nFirst paragraph here.\n\nSecond.";
  assert.equal(parseSkillDescription(content), "First paragraph here.");
});

test("parseSkillDescription: undefined when nothing usable", () => {
  assert.equal(parseSkillDescription(""), undefined);
});

// ─── buildSkillBlock ─────────────────────────────────────────────────────────

test("buildSkillBlock: renders instruction and skill XML", () => {
  const skills: ResolvedSkillRef[] = [
    { name: "review", filePath: "/s/review/SKILL.md", baseDir: "/s/review", description: "Review <code> & stuff" },
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
  writeSkill(join(project, ".agents", "skills"), "flat-skill", "Flat one.");
  // Nested layout: <dir>/<group>/<name>/SKILL.md
  writeSkill(join(home, ".agents", "skills", "group"), "nested-skill", "Nested one.");
  writeSkill(join(home, ".pi", "agent", "skills"), "home-skill", "Home one.");

  const entries = await scanSkillDirs(project, home);
  const names = [...entries.keys()].sort();
  assert.deepEqual(names, ["flat-skill", "home-skill", "nested-skill"]);
  const flat = entries.get("flat-skill")!;
  assert.equal(flat.description, "Flat one.");
  assert.ok(flat.filePath.endsWith("SKILL.md"));
});

test("scanSkillDirs: project dir takes precedence over home for duplicates", async () => {
  const project = makeTempDir();
  const home = makeTempDir();
  writeSkill(join(project, ".agents", "skills"), "dup", "From project.");
  writeSkill(join(home, ".agents", "skills"), "dup", "From home.");
  const entries = await scanSkillDirs(project, home);
  assert.equal(entries.get("dup")?.description, "From project.");
});

// ─── before_agent_start expansion ────────────────────────────────────────────

test("before_agent_start: injects hidden custom message for $refs", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "please $review this diff", [authoritativeSkill("review")]);
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
  const result = await emitBeforeAgentStart(fake, "run $nonexistent now", [authoritativeSkill("review")]);
  assert.equal(result, undefined);
});

test("before_agent_start: mixes known and unknown refs, keeping known", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  const result = await emitBeforeAgentStart(fake, "$review and $ghost", [authoritativeSkill("review")]);
  assert.ok(result?.message);
  assert.match(result.message.content, /<skill name="review">/);
  assert.doesNotMatch(result.message.content, /ghost/);
});

// ─── input event (streaming steer/followUp) ─────────────────────────────────

test("input: steered $ref sends hidden custom message with deliverAs steer", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  // Warm the cache via a prior turn.
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);

  const handler = fake.handlers.get("input");
  assert.ok(handler, "input handler registered");
  const result = await handler(
    { type: "input", text: "also apply $review", source: "interactive", streamingBehavior: "steer" },
    fake.ctx,
  );
  // User text must pass through untouched.
  assert.ok(result === undefined || (result as { action?: string }).action === "continue");
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0]!.message.customType, "skill-refs");
  assert.equal(fake.sent[0]!.message.display, false);
  assert.match(String(fake.sent[0]!.message.content), /<skill name="review">/);
  assert.equal(fake.sent[0]!.options?.deliverAs, "steer");
});

test("input: followUp $ref uses deliverAs followUp", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("audit")]);

  const handler = fake.handlers.get("input")!;
  await handler(
    { type: "input", text: "then $audit", source: "interactive", streamingBehavior: "followUp" },
    fake.ctx,
  );
  assert.equal(fake.sent[0]!.options?.deliverAs, "followUp");
});

test("input: idle input is left to before_agent_start (no sendMessage)", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);

  const handler = fake.handlers.get("input")!;
  const result = await handler(
    { type: "input", text: "apply $review", source: "interactive", streamingBehavior: undefined },
    fake.ctx,
  );
  assert.ok(result === undefined || (result as { action?: string }).action === "continue");
  assert.equal(fake.sent.length, 0);
});

test("input: steered text without refs sends nothing", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm up", [authoritativeSkill("review")]);

  const handler = fake.handlers.get("input")!;
  await handler(
    { type: "input", text: "no refs", source: "interactive", streamingBehavior: "steer" },
    fake.ctx,
  );
  assert.equal(fake.sent.length, 0);
});

// ─── session_start cold-start scan + autocomplete registration ──────────────

test("session_start: scans filesystem and registers $ autocomplete", async () => {
  const project = makeTempDir();
  writeSkill(join(project, ".agents", "skills"), "cold-skill", "Cold start skill.");

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
    { getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) },
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
    { getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) },
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
    { getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) },
    () => [{ name: "review" }],
  );
  const result = provider.applyCompletion(["do $rev now"], 0, 7, { value: "$review", label: "review" }, "$rev");
  assert.equal(result.lines[0], "do $review now");
  assert.equal(result.cursorCol, 10);
});

test("completion wrapper: shouldTriggerFileCompletion true for $ token", () => {
  const provider = createSkillCompletionWrapper(
    { getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) },
    () => [],
  );
  assert.equal(provider.shouldTriggerFileCompletion?.(["$re"], 0, 3), true);
  assert.equal(provider.shouldTriggerFileCompletion?.(["plain"], 0, 5), false);
});

// ─── authoritative refresh replaces stale entries ────────────────────────────

test("before_agent_start: refresh replaces authoritative list", async () => {
  const fake = createFakePi();
  skillRefsExtension(fake.pi as never);
  await emitBeforeAgentStart(fake, "warm", [authoritativeSkill("old-skill")]);
  // Second turn: old-skill removed, new-skill added.
  const result = await emitBeforeAgentStart(fake, "$old-skill $new-skill", [authoritativeSkill("new-skill")]);
  assert.ok(result?.message);
  assert.match(result.message.content, /<skill name="new-skill">/);
  assert.doesNotMatch(result.message.content, /<skill name="old-skill">/);
});
