import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { withLoopSession, type LoopProbeCall } from "../../test/helpers/stuck-loop-session.js";

const config = { streamWatchdogEnabled: false, doomLoop: { action: "deny" } };

function notices(session: AgentSession, kind: "similar" | "cycle"): AgentSession["messages"] {
  return session.messages.filter(
    (message) => message.role === "custom" && message.customType === `stuck-guard-${kind}-loop`,
  );
}

function cycleCalls(period: number, repetitions: number): LoopProbeCall[] {
  return Array.from({ length: period * repetitions }, (_, index) => ({
    toolName: index % period === 0 ? "loop_probe" : "other_probe",
    input: { operation: index % period, query: "inspect the same unchanged operation" },
  }));
}

function similarCalls(count: number): LoopProbeCall[] {
  return Array.from({ length: count }, (_, index) => ({
    input: {
      taskId: "1",
      status: "in_progress",
      activeForm: `Inspecting the same unchanged task, pass ${index}`,
    },
  }));
}

test("mixed-file scans and overlapping pages return new evidence without reminders", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    const scans = [
      { path: "module-tests.lua", offsets: [1, 1100, 2100] },
      { path: "module-guide.mdx", offsets: [1, 900] },
      { path: "CHANGELOG.md", offsets: [1] },
    ];
    await Promise.all(
      scans.map((scan) =>
        fs.writeFile(
          path.join(directory, scan.path),
          Array.from({ length: 2377 }, (_, index) => `Source line ${index + 1}`).join("\n"),
        ),
      ),
    );
    const calls: LoopProbeCall[] = [];
    for (const scan of scans) {
      for (const offset of scan.offsets) {
        calls.push({ toolName: "read", input: { path: scan.path, offset, limit: 1100 } });
      }
    }
    await prompt(calls);
    assert.equal(notices(session, "similar").length, 0);
    assert.equal(notices(session, "cycle").length, 0);
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 6);
    assert.ok(results.every((result) => !result.isError));
    assert.match(JSON.stringify(results[2]), /Source line 2377/);
  });
});

test("byte-truncated reads use returned coverage, not the requested limit", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    await fs.writeFile(
      path.join(directory, "large.txt"),
      Array.from(
        { length: 300 },
        (_, index) => `${String(index + 1).padStart(3, "0")} ${"x".repeat(1020)}`,
      ).join("\n"),
    );
    await prompt(
      Array.from({ length: 6 }, (_, index) => ({
        toolName: "read",
        input: { path: "large.txt", offset: 1 + index * 49, limit: 2000 },
      })),
    );
    assert.equal(notices(session, "similar").length, 0);
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 6);
    assert.ok(results.every((result) => !result.isError));
    assert.match(JSON.stringify(results[0]), /Use offset=50/);
    assert.match(JSON.stringify(results[5]), /294 /);
  });
});

test("revisiting covered ranges still warns despite slightly changed limits", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    await fs.writeFile(
      path.join(directory, "source.txt"),
      Array.from({ length: 300 }, (_, index) => `Source line ${index + 1}`).join("\n"),
    );
    await prompt([
      { toolName: "read", input: { path: "source.txt", offset: 1, limit: 300 } },
      ...Array.from({ length: 10 }, (_, index) => ({
        toolName: "read",
        input: { path: index % 2 ? "./source.txt" : "source.txt", offset: 1, limit: 100 + index },
      })),
    ]);
    assert.equal(notices(session, "similar").length, 2);
    assert.ok(
      session.messages
        .filter((message) => message.role === "toolResult")
        .every((result) => !result.isError),
    );
  });
});

test("single blank-line pages count as returned rows", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    await fs.writeFile(path.join(directory, "blank-lines.txt"), "\n".repeat(20));
    await prompt(
      Array.from({ length: 10 }, (_, index) => ({
        toolName: "read",
        input: { path: "blank-lines.txt", offset: index + 1, limit: 1 },
      })),
    );
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 10);
    assert.ok(results.every((result) => !result.isError));
    assert.match(JSON.stringify(results[9]), /Use offset=11/);
    assert.equal(notices(session, "similar").length, 0);
  });
});

test("distinct path spellings do not exempt repeated coverage", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    await fs.writeFile(
      path.join(directory, "source.txt"),
      Array.from({ length: 300 }, (_, index) => `Source line ${index + 1}`).join("\n"),
    );
    await prompt([
      { toolName: "read", input: { path: "source.txt", offset: 1, limit: 300 } },
      ...Array.from({ length: 10 }, (_, index) => ({
        toolName: "read",
        input: { path: `${"./".repeat(index + 1)}source.txt`, offset: 1, limit: 101 + index },
      })),
    ]);
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 11);
    assert.ok(results.every((result) => !result.isError));
    assert.equal(notices(session, "similar").length, 2);
  });
});

test("failed reads do not count as pagination progress", async () => {
  await withLoopSession(config, async ({ session, prompt }) => {
    await prompt(
      Array.from({ length: 10 }, (_, index) => ({
        toolName: "read",
        input: { path: "missing-source-module.txt", offset: 1 + index * 100, limit: 100 },
      })),
    );
    assert.equal(notices(session, "similar").length, 2);
    assert.ok(
      session.messages
        .filter((message) => message.role === "toolResult")
        .every((result) => result.isError),
    );
  });
});

for (const period of [2, 3, 4, 5, 6]) {
  test(`period-${period} cycles warn at three repetitions without blocking`, async () => {
    await withLoopSession(config, async ({ session, executed, prompt }) => {
      await prompt(cycleCalls(period, 3));
      assert.equal(executed.length, period * 3);
      const warnings = notices(session, "cycle");
      assert.equal(warnings.length, 1);
      assert.match(JSON.stringify(warnings[0]), /3 repetitions/);
      assert.match(JSON.stringify(warnings[0]), new RegExp(`period ${period}`));
    });
  });
}

test("cycle reminders double and saturate without rotation spam; changed work breaks the cycle", async () => {
  await withLoopSession(config, async ({ session, executed, prompt }) => {
    await prompt(cycleCalls(2, 45));
    assert.equal(executed.length, 90);
    const warnings = notices(session, "cycle");
    assert.equal(warnings.length, 5);
    for (const [index, count] of [3, 6, 12, 24, 32].entries()) {
      assert.match(JSON.stringify(warnings[index]), new RegExp(`${count} repetitions`));
    }
    await prompt(
      cycleCalls(2, 5).map((call, index) => ({
        ...call,
        input: { ...call.input, revision: index },
      })),
      "extension",
    );
    assert.equal(notices(session, "cycle").length, 5);
    await prompt(cycleCalls(2, 3), "extension");
    assert.equal(notices(session, "cycle").length, 6);
  });
});

test("real user input resets advisory history; extension input preserves it", async () => {
  for (const source of ["interactive", "rpc", "extension"] as const) {
    await withLoopSession(config, async ({ session, prompt }) => {
      await prompt(similarCalls(4));
      await prompt(similarCalls(1), source);
      assert.equal(notices(session, "similar").length, source === "extension" ? 1 : 0);
    });
    await withLoopSession(config, async ({ session, prompt }) => {
      await prompt(cycleCalls(2, 2));
      await prompt(cycleCalls(2, 1), source);
      assert.equal(notices(session, "cycle").length, source === "extension" ? 1 : 0);
    });
  }
});

test("codemode sequential and parallel reads stay silent while nested cycles warn", async () => {
  await withLoopSession(config, async ({ directory, session, prompt }) => {
    await fs.writeFile(
      path.join(directory, "source.txt"),
      Array.from({ length: 5000 }, (_, index) => `Source line ${index + 1}`).join("\n"),
    );
    await prompt([
      {
        toolName: "codemode",
        input: {
          code: `
      for (let offset = 1; offset <= 2500; offset += 500) {
        text(await tools.read({ path: "source.txt", offset, limit: 500 }));
      }
      const results = await Promise.all([2501, 3001, 3501, 4001, 4501].map(offset =>
        tools.read({ path: "source.txt", offset, limit: 500 })));
      for (const result of results) text(result);
    `,
        },
      },
    ]);
    assert.equal(notices(session, "similar").length, 0);
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    assert.ok(result && result.role === "toolResult" && !result.isError);
    assert.match(JSON.stringify(result), /Source line 5000/);
    await prompt([
      {
        toolName: "codemode",
        input: {
          code: `
      for (let i = 0; i < 3; i++) {
        await tools.loop_probe({ payload: { operation: "read" } });
        await tools.other_probe({ payload: { operation: "check" } });
      }
      text("Cycle completed.");
    `,
        },
      },
    ]);
    assert.equal(notices(session, "cycle").length, 1);
  });
});

test("cycle detection obeys allow and never opens ask dialogs", async () => {
  for (const action of ["allow", "ask"] as const) {
    await withLoopSession(
      { ...config, doomLoop: { action } },
      async ({ session, executed, prompt }) => {
        const dialogs: string[] = [];
        session.extensionRunner.setUIContext(
          {
            ...session.extensionRunner.getUIContext(),
            select: async (title) => {
              dialogs.push(title);
              return "Reject";
            },
          },
          "tui",
        );
        await prompt(cycleCalls(3, 8));
        assert.equal(executed.length, 24);
        assert.deepEqual(dialogs, []);
        assert.equal(notices(session, "cycle").length, action === "allow" ? 0 : 2);
      },
    );
  }
});
