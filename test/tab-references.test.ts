import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  prepareTabReferencePrompt,
  type PreparedTabReferencePrompt,
} from "../src/core/tab-references.js";

const self = { title: "Self", sessionId: "self", workdir: "/unused" };
const review = { title: "Review", sessionId: "review" };

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-tab-references-"));
  const target = { ...self, workdir: dir };
  const env = { PI_CODING_AGENT_DIR: path.join(dir, "agent") };
  return { dir, target, env };
}

test("preparation preserves submission order across filesystem probes and failures", async () => {
  const { dir, target } = await fixture();
  try {
    const order: string[] = [];
    await Promise.all([
      prepareTabReferencePrompt("@Review", [review], target).then(() => order.push("reference")),
      prepareTabReferencePrompt("plain", [review], target).then(() => order.push("plain")),
    ]);
    assert.deepEqual(order, ["reference", "plain"]);
    await fs.writeFile(path.join(dir, "Review"), "file");
    const rejected = prepareTabReferencePrompt("@Review", [review], target);
    const following = prepareTabReferencePrompt("after error", [review], target);
    await assert.rejects(rejected, /Error: File or directory conflicts/);
    assert.deepEqual(await following, { text: "after error", contextMessages: [] });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function context(prompt: PreparedTabReferencePrompt) {
  assert.equal(prompt.contextMessages.length, 1);
  const message = prompt.contextMessages[0]!;
  assert.equal(message.display, false);
  assert.equal(message.customType, "tab-references");
  assert.equal(typeof message.content, "string");
  const block = (message.content as string).split("<mpi-tab-references>\n")[1];
  assert.ok(block, "model prompt contains tab reference context");
  return JSON.parse(block.slice(0, -"\n</mpi-tab-references>".length));
}

test("references carry distinct current targets and the configured skill path", async () => {
  const { dir, target, env } = await fixture();
  try {
    const text = 'Ask @Review and @"中文 \\"审查\\"" then @Review';
    const quoted = { title: '中文 "审查"', sessionId: "quoted" };
    const output = await prepareTabReferencePrompt(text, [target, review, quoted], target, env);
    assert.equal(output.text, text);
    const attached = context(output);
    assert.deepEqual(attached.targets, [
      { title: "Review", pid: process.pid, sessionId: "review" },
      { title: '中文 "审查"', pid: process.pid, sessionId: "quoted" },
    ]);
    assert.equal(
      attached.skill,
      path.join(dir, "agent/extensions/mpi-ctl-skill/skills/mpi-ctl/SKILL.md"),
    );
    assert.match(attached.instruction, /read.*skill/i);
    assert.match(attached.instruction, /--session/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("non-references, self, code, commands and unknown titles retain the exact input", async () => {
  const target = { ...self, workdir: "/definitely-missing-tab-reference-directory" };
  for (const text of [
    "ordinary text",
    "@Self @Unknown @src/file.ts",
    "email@Review",
    "`@Review`",
    "```text\n@Review\n```",
    "~~~\n@Review\n~~~",
    " /template @Review",
    "!echo @Review",
    "!!echo @Review",
  ]) {
    assert.deepEqual(await prepareTabReferencePrompt(text, [target, review], target), {
      text,
      contextMessages: [],
    });
  }
});

test("only references outside code are resolved and renamed titles are not rebound", async () => {
  const { dir, target } = await fixture();
  try {
    const text = "`@Old`\n```\n@Old\n```\n@Review";
    const output = await prepareTabReferencePrompt(text, [target, review], target);
    assert.equal(context(output).targets[0].sessionId, "review");
    assert.deepEqual(await prepareTabReferencePrompt("@Old", [target, review], target), {
      text: "@Old",
      contextMessages: [],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("duplicate titles and existing filesystem entries reject without choosing a target", async () => {
  const { dir, target } = await fixture();
  try {
    await assert.rejects(
      prepareTabReferencePrompt("@Review", [review, { ...review, sessionId: "another" }], target),
      /Error:.*ambiguous.*Review/i,
    );
    await fs.writeFile(path.join(dir, "Review"), "file");
    await assert.rejects(
      prepareTabReferencePrompt("@Review", [review], target),
      /Error:.*file.*Review/i,
    );
    await fs.rm(path.join(dir, "Review"));
    await fs.mkdir(path.join(dir, "Review"));
    await assert.rejects(
      prepareTabReferencePrompt("@Review", [review], target),
      /Error:.*file.*Review/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resubmission resolves current targets without changing user text", async () => {
  const { dir, target } = await fixture();
  try {
    const first = await prepareTabReferencePrompt("Ask @Review", [review], target);
    const next = await prepareTabReferencePrompt(
      first.text,
      [{ ...review, sessionId: "new-session" }],
      target,
    );
    assert.equal(context(next).targets[0].sessionId, "new-session");
    assert.equal(next.text, "Ask @Review");
    const literal = "Keep <mpi-tab-references> literally";
    assert.deepEqual(await prepareTabReferencePrompt(literal, [review], target), {
      text: literal,
      contextMessages: [],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
