import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  buildMixCodeSystemPrompt,
  buildMixCodeSystemPromptFromParts,
  MIXCODE_SYSTEM_PROMPT,
  setGlobalConversationHistoryPrompt,
} from "../src/index.js";

test("buildMixCodeSystemPrompt loads project context files into the prompt", async () => {
  setGlobalConversationHistoryPrompt(undefined);
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-prompt-"));
  try {
    const repo = join(dir, "repo");
    const child = join(repo, "pkg", "leaf");
    const agentDir = join(dir, "agent");
    await mkdir(child, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "Global agent rules", "utf8");
    await writeFile(join(repo, "AGENTS.md"), "Repo agent rules", "utf8");
    await writeFile(join(repo, "pkg", "CLAUDE.md"), "Package agent rules", "utf8");

    const prompt = await buildMixCodeSystemPrompt({ workdir: child, agentDir });

    assert.match(prompt, /<project_context>/);
    assert.match(prompt, /Global agent rules/);
    assert.match(prompt, /Repo agent rules/);
    assert.match(prompt, /Package agent rules/);
    assert.match(prompt, new RegExp(`Current working directory: ${child.replace(/\\/g, "\\\\")}`));
    assert.doesNotMatch(prompt, /Pi documentation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildMixCodeSystemPrompt uses project SYSTEM and append prompt files", async () => {
  setGlobalConversationHistoryPrompt(undefined);
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-files-"));
  try {
    const repo = join(dir, "repo");
    const agentDir = join(dir, "agent");
    await mkdir(join(repo, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(repo, ".pi", "SYSTEM.md"), "Project system prompt", "utf8");
    await writeFile(join(repo, ".pi", "APPEND_SYSTEM.md"), "Append prompt", "utf8");

    const prompt = await buildMixCodeSystemPrompt({
      workdir: repo,
      agentDir,
      basePrompt: "Fallback prompt",
    });

    assert.match(prompt, /Project system prompt/);
    assert.match(prompt, /Append prompt/);
    assert.doesNotMatch(prompt, /Fallback prompt/);
    assert.doesNotMatch(prompt, /Pi documentation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildMixCodeSystemPrompt includes project skills from Pi resource loader", async () => {
  setGlobalConversationHistoryPrompt(undefined);
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-skills-"));
  try {
    const repo = join(dir, "repo");
    const agentDir = join(dir, "agent");
    await mkdir(join(repo, ".agents", "skills", "review"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(repo, ".agents", "skills", "review", "SKILL.md"),
      "---\ndescription: Review code carefully\n---\n\nUse focused review checks.",
      "utf8",
    );

    const prompt = await buildMixCodeSystemPrompt({ workdir: repo, agentDir });

    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /<name>review<\/name>/);
    assert.match(prompt, /Review code carefully/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildMixCodeSystemPrompt falls back when project resources are empty", async () => {
  setGlobalConversationHistoryPrompt(undefined);
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-fallback-"));
  try {
    const repo = join(dir, "repo");
    const agentDir = join(dir, "agent");
    await mkdir(repo, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const prompt = await buildMixCodeSystemPrompt({
      workdir: repo,
      agentDir,
      basePrompt: "Base prompt",
    });

    assert.match(prompt, /^Base prompt/);
    assert.doesNotMatch(prompt, /<project_context>/);
    assert.doesNotMatch(prompt, /Available skills/);
    assert.match(prompt, new RegExp(`Current working directory: ${repo.replace(/\\/g, "\\\\")}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildMixCodeSystemPrompt formats tools, search guidance, and prompt guidelines", async () => {
  setGlobalConversationHistoryPrompt(undefined);
  const dir = await mkdtemp(join(tmpdir(), "mixcode-system-tools-"));
  try {
    const repo = join(dir, "repo");
    const agentDir = join(dir, "agent");
    await mkdir(repo, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const prompt = await buildMixCodeSystemPrompt({
      workdir: repo,
      agentDir,
      selectedTools: ["read", "bash", "grep"],
      toolSnippets: {
        read: "Read file contents",
        bash: "Execute bash commands (ls, grep, find, etc.)",
        grep: "Search file contents for patterns (respects .gitignore)",
      },
      promptGuidelines: ["Use read to examine files instead of cat or sed.", "  "],
      searchTools: { hasRg: true, hasFd: true },
    });

    assert.match(prompt, /- read: Read file contents/);
    assert.match(prompt, /- bash: Execute bash commands \(ls, grep, find, etc\.\)/);
    assert.match(prompt, /- grep: Search file contents for patterns \(respects \.gitignore\)/);
    assert.match(prompt, /ALWAYS use `rg` \(ripgrep\)\./);
    assert.match(prompt, /ALWAYS use `fd`\./);
    assert.doesNotMatch(prompt, /NEVER use `grep`/);
    assert.doesNotMatch(prompt, /NEVER use `find`/);
    assert.match(prompt, /Use read to examine files instead of cat or sed\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("global conversation history prompt is appended when configured", () => {
  try {
    setGlobalConversationHistoryPrompt("Local conversation history:\n- path only");
    const prompt = buildMixCodeSystemPromptFromParts({
      customPrompt: MIXCODE_SYSTEM_PROMPT,
      cwd: "/repo",
      selectedTools: [],
    });
    assert.match(prompt, /Local conversation history:\n- path only/);
  } finally {
    setGlobalConversationHistoryPrompt(undefined);
  }
});

test("default MixCode prompt expands tools and search guidance before assembly", () => {
  setGlobalConversationHistoryPrompt(undefined);
  const prompt = buildMixCodeSystemPromptFromParts({
    customPrompt: MIXCODE_SYSTEM_PROMPT,
    cwd: "/repo",
    selectedTools: ["bash"],
    toolSnippets: { bash: "Execute bash commands" },
    searchTools: { hasRg: true, hasFd: true },
  });

  assert.match(prompt, /Available tools:\n- bash: Execute bash commands/);
  assert.match(prompt, /ALWAYS use `rg` \(ripgrep\)\./);
  assert.match(prompt, /ALWAYS use `fd`\./);
  assert.doesNotMatch(prompt, /NEVER use `grep`/);
  assert.doesNotMatch(prompt, /NEVER use `find`/);
});

test("custom base identity still keeps tools, project context, and skills", () => {
  setGlobalConversationHistoryPrompt(undefined);
  const prompt = buildMixCodeSystemPromptFromParts({
    customPrompt: "You are a strict code reviewer focused on API breaks.",
    cwd: "/repo",
    selectedTools: ["read", "bash"],
    toolSnippets: { read: "Read files", bash: "Execute bash commands" },
    contextFiles: [{ path: "/repo/AGENTS.md", content: "Repo rules" }],
    skills: [
      {
        name: "review",
        description: "Review workflow",
        filePath: "/repo/.agents/skills/review/SKILL.md",
        baseDir: "/repo/.agents/skills/review",
        sourceInfo: {
          path: "/repo/.agents/skills/review/SKILL.md",
          source: "project",
          scope: "project",
          origin: "top-level",
        },
        disableModelInvocation: false,
      },
    ],
  });

  assert.match(prompt, /^You are a strict code reviewer focused on API breaks\./);
  assert.match(prompt, /Available tools:\n- read: Read files\n- bash: Execute bash commands/);
  assert.match(prompt, /Repo rules/);
  assert.match(prompt, /review/);
  assert.match(prompt, /Review workflow/);
});
