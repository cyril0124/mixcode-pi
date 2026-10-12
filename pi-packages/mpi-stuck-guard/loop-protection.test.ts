import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { withLoopSession, type LoopProbeCall } from "../../test/helpers/stuck-loop-session.js";
import { parseStuckGuardConfig } from "./config.js";
import schema from "./mpi-stuck-guard.schema.json" with { type: "json" };

const config = { streamWatchdogEnabled: false, doomLoop: { action: "deny" } };

/** Vary content and key order while repeatedly reporting the same operation. */
function progressCalls(count: number): LoopProbeCall[] {
  return Array.from({ length: count }, (_, index) => {
    const activeForm = `Inspecting the same operation for repeated progress updates, pass ${index}`;
    if (index % 2 === 0) {
      return { input: { taskId: "1", status: "in_progress", activeForm } };
    }
    return { input: { activeForm, status: "in_progress", taskId: "1" } };
  });
}

test("canonical arguments catch nested key permutations without changing arrays or string values", async () => {
  await withLoopSession(config, async ({ session, executed, prompt }) => {
    const first = { nested: { a: 1, b: [1, 2] }, text: "first value" };
    const reordered = { text: "first value", nested: { b: [1, 2], a: 1 } };
    await prompt([
      { input: first },
      { input: reordered },
      { input: first },
      { input: reordered },
      { input: first },
    ]);
    assert.deepEqual(executed, [first, reordered]);
    const failure = session.messages.find(
      (message) => message.role === "toolResult" && message.isError,
    );
    assert.ok(failure && failure.role === "toolResult");
    assert.match(JSON.stringify(failure.content), /identical input/);
    assert.equal(
      session.messages.filter((message) => message.role === "toolResult" && message.isError).length,
      3,
    );
    assert.equal(
      session.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) => block.type === "text" && block.text === "Probe sequence finished.",
          ),
      ),
      false,
    );
    await prompt([
      { input: { ...first, nested: { a: 1, b: [2, 1] } } },
      { input: { ...first, text: "second value" } },
    ]);
    assert.equal(executed.length, 4);
  });
});

test("similar calls remain advisory through doubled counts and tracker saturation", async () => {
  await withLoopSession(
    { ...config, similarCallThreshold: 5 },
    async ({ session, executed, prompt }) => {
      await prompt(progressCalls(90));
      assert.equal(executed.length, 90);
      assert.equal(
        session.messages.some((message) => message.role === "toolResult" && message.isError),
        false,
      );
      const notices = session.messages.filter(
        (message) => message.role === "custom" && message.customType === "stuck-guard-similar-loop",
      );
      const noticeCounts = notices.map(
        (notice) =>
          session.messages
            .slice(0, session.messages.indexOf(notice))
            .filter((message) => message.role === "toolResult" && !message.isError).length,
      );
      assert.deepEqual(noticeCounts, [5, 10, 20, 40, 64]);
      assert.ok(notices.every((notice) => !JSON.stringify(notice).includes("deny policy")));
      assert.equal(
        session.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (block) => block.type === "text" && block.text === "Probe sequence finished.",
            ),
        ),
        true,
      );
    },
  );
});

test("similar warnings never veto changed arguments after isolated identical-call blocks", async () => {
  await withLoopSession(config, async ({ session, executed, prompt }) => {
    const variants = progressCalls(4);
    const sequence = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3];
    await prompt(sequence.map((index) => variants[index]!));
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 10);
    assert.equal(executed.length, 7);
    for (const index of [2, 5, 8]) {
      assert.equal(results[index]!.isError, true);
      assert.match(JSON.stringify(results[index]!.content), /stuck-guard: doom_loop/);
    }
    assert.equal(results[9]!.isError, false);
    const notices = session.messages.filter(
      (message) => message.role === "custom" && message.customType === "stuck-guard-similar-loop",
    );
    assert.equal(notices.length, 2);
  });
});

test("changed tools and dissimilar inputs start fresh similarity episodes", async () => {
  await withLoopSession(
    { ...config, similarCallThreshold: 4 },
    async ({ session, executed, prompt }) => {
      const calls = progressCalls(7);
      await prompt([
        ...calls,
        { toolName: "other_probe", input: { query: "another source" } },
        ...progressCalls(7),
        { input: { query: "completely different evidence with no shared progress fields" } },
        ...progressCalls(7),
      ]);
      assert.equal(executed.length, 23);
      assert.equal(
        session.messages.some((message) => message.role === "toolResult" && message.isError),
        false,
      );
      const notices = session.messages.filter(
        (message) => message.role === "custom" && message.customType === "stuck-guard-similar-loop",
      );
      assert.equal(notices.length, 3);
    },
  );
});

test("a configured count reload resets an ongoing episode before the next prompt", async () => {
  await withLoopSession(
    { ...config, similarCallThreshold: 4 },
    async ({ session, executed, prompt, configure }) => {
      await prompt(progressCalls(7));
      await configure({ ...config, similarCallThreshold: 6 });
      await prompt(progressCalls(11));
      assert.equal(executed.length, 18);
      const notices = session.messages.filter(
        (message) => message.role === "custom" && message.customType === "stuck-guard-similar-loop",
      );
      assert.equal(notices.length, 2);
      assert.match(JSON.stringify(notices[1]), /6 calls/);
      assert.equal(
        session.messages.some((message) => message.role === "toolResult" && message.isError),
        false,
      );
    },
  );
});

test("varied work and allow policy do not trigger similarity protection", async () => {
  await withLoopSession(config, async ({ session, executed, prompt }) => {
    await prompt([
      { input: { query: "alpha", limit: 50 } },
      { input: { source: ["database", "network"], version: 9 } },
      { input: { nested: { enabled: true, offset: 400 } } },
      { input: { path: "/tmp/result.txt", contents: "new evidence" } },
      { input: { failures: [4, 8, 19], severity: "high" } },
      { input: { address: "0xabc", seed: 777 } },
    ]);
    assert.equal(executed.length, 6);
    assert.equal(
      session.messages.some((message) => message.role === "custom"),
      false,
    );
  });
  await withLoopSession(
    { ...config, doomLoop: { action: "allow" } },
    async ({ session, executed, prompt }) => {
      await prompt(progressCalls(15));
      assert.equal(executed.length, 15);
      assert.equal(
        session.messages.some((message) => message.role === "custom"),
        false,
      );
    },
  );
});

test("similar calls under ask never open an approval dialog", async () => {
  await withLoopSession(
    { ...config, doomLoop: { action: "ask" }, similarCallThreshold: 4 },
    async ({ session, executed, prompt }) => {
      const optionsSeen: string[][] = [];
      const ui: ExtensionUIContext = {
        ...session.extensionRunner.getUIContext(),
        select: async (_title, options) => {
          optionsSeen.push(options);
          return "Reject";
        },
      };
      session.extensionRunner.setUIContext(ui, "tui");
      await prompt(progressCalls(20));
      assert.equal(executed.length, 20);
      assert.deepEqual(optionsSeen, []);
      assert.equal(
        session.messages.some((message) => message.role === "toolResult" && message.isError),
        false,
      );
      const notices = session.messages.filter(
        (message) => message.role === "custom" && message.customType === "stuck-guard-similar-loop",
      );
      assert.equal(notices.length, 3);
    },
  );
});

test("distinct read targets stay silent while same-file pagination warns without blocking", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    const contents = Array.from({ length: 100 }, (_, index) => `Source line ${index + 1}`).join(
      "\n",
    );
    const paths = Array.from({ length: 12 }, (_, index) =>
      path.join(directory, `source-module-${index}.txt`),
    );
    await Promise.all(paths.map((file) => fs.writeFile(file, contents)));
    await prompt(
      paths.map((file) => ({ toolName: "read", input: { path: file, offset: 1, limit: 5 } })),
    );
    assert.equal(session.messages.filter((message) => message.role === "custom").length, 0);
    let results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 12);
    assert.ok(results.every((result) => !result.isError));
    await prompt(
      Array.from({ length: 20 }, (_, index) => ({
        toolName: "read",
        input: { path: paths[11]!, offset: index * 5 + 1, limit: 5 },
      })),
    );
    results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 32);
    assert.ok(results.every((result) => !result.isError));
    assert.ok(JSON.stringify(results.at(-1)).includes("Source line 100"));
    const notices = session.messages.filter(
      (message) => message.role === "custom" && message.customType === "stuck-guard-similar-loop",
    );
    assert.equal(notices.length, 3);
  });
});

test("similar threshold schema and parser agree on bounded integer counts", () => {
  for (const value of [2, 5, 64]) {
    const raw = { similarCallThreshold: value };
    assert.equal(Value.Check(schema, raw), true);
    const parsed = parseStuckGuardConfig(raw);
    assert.ok(parsed.ok);
    assert.equal(parsed.config.similarCallThreshold, value);
  }
  for (const value of [0, 1, 65, 2.5, "5", null]) {
    const raw = { similarCallThreshold: value };
    assert.equal(Value.Check(schema, raw), false);
    assert.equal(parseStuckGuardConfig(raw).ok, false);
  }
});
