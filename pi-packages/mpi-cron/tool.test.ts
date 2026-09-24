/**
 * Contract tests for the `cron` tool: argument validation, the recursive-add
 * guard, id/name resolution, and the error shape the model sees. The hub is a
 * recorded fake, so no timer or file is touched.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCronTool, deriveJobName, findJob, isInsideScheduledRun } from "./tool.js";
import type { CronJob } from "./types.js";

function job(overrides: Omit<Partial<CronJob>, "id"> & { id: string }): CronJob {
  return {
    name: overrides.id,
    prompt: "check the deploy",
    schedule: { kind: "interval", intervalMs: 300_000, source: "5m" },
    enabled: true,
    runCount: 0,
    createdAt: 0,
    ...overrides,
  };
}

/** Recorded fake hub: every call is captured, nothing is scheduled. */
function makeHub(initial: CronJob[] = []) {
  const state = { jobs: [...initial] };
  const calls: string[] = [];
  let counter = initial.length;
  return {
    state,
    calls,
    hub: {
      refresh: async () => {
        calls.push("refresh");
        return [...state.jobs];
      },
      add: async (input: Record<string, unknown>) => {
        calls.push("add");
        const created = job({
          id: `new-${++counter}`,
          name: String(input.name),
          prompt: String(input.prompt),
          schedule: input.schedule as CronJob["schedule"],
          createdBy: input.createdBy as string | undefined,
        });
        created.nextRun = Date.now() + 60_000;
        state.jobs.push(created);
        return created;
      },
      update: async (id: string, patch: Partial<CronJob>) => {
        calls.push(`update:${id}`);
        const index = state.jobs.findIndex((entry) => entry.id === id);
        const updated: CronJob = { ...state.jobs[index]!, ...patch };
        state.jobs[index] = updated;
        return updated;
      },
      remove: async (id: string) => {
        calls.push(`remove:${id}`);
        state.jobs = state.jobs.filter((entry) => entry.id !== id);
        return true;
      },
      fireNow: async (id: string) => {
        calls.push(`fire:${id}`);
        return "done" as const;
      },
    },
  };
}

type FakeHub = ReturnType<typeof makeHub>["hub"];

/** Session id the fake context reports; `add` records it as the job's creator. */
const TEST_SESSION = "session-under-test";

function context(entries: unknown[] = []): ExtensionContext {
  return {
    sessionManager: { getEntries: () => entries, getSessionId: () => TEST_SESSION },
  } as unknown as ExtensionContext;
}

async function callTool(
  hub: FakeHub,
  params: Record<string, unknown>,
  entries: unknown[] = [],
  resolveCreatedBy?: (ctx: ExtensionContext) => string | undefined,
) {
  const tool = createCronTool(() => hub as never, resolveCreatedBy);
  const result = await tool.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    context(entries),
  );
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  return { text, details: result.details };
}

describe("findJob", () => {
  test("resolves by exact id, then unique name, then unique id prefix", () => {
    const jobs = [job({ id: "abc123", name: "nightly" }), job({ id: "def456", name: "daily" })];
    expect(findJob(jobs, "abc123")?.id).toBe("abc123");
    expect(findJob(jobs, "NIGHTLY")?.id).toBe("abc123");
    expect(findJob(jobs, "def")?.id).toBe("def456");
    expect(findJob(jobs, "nope")).toBeUndefined();
  });

  test("returns undefined for an ambiguous prefix rather than guessing", () => {
    const jobs = [job({ id: "ab-1", name: "one" }), job({ id: "ab-2", name: "two" })];
    expect(findJob(jobs, "ab")).toBeUndefined();
  });
});

describe("deriveJobName", () => {
  test("builds a short slug from the prompt and avoids collisions", () => {
    expect(deriveJobName("Check the deploy status of prod", new Set())).toBe(
      "check-the-deploy-status",
    );
    expect(
      deriveJobName("Check the deploy status of prod", new Set(["check-the-deploy-status"])),
    ).toBe("check-the-deploy-status-2");
    expect(deriveJobName("!!!", new Set())).toBe("job");
  });
});

describe("isInsideScheduledRun", () => {
  test("is scoped to the current turn, not to a fixed entry window", () => {
    // An empty session is not a fired-prompt run.
    expect(isInsideScheduledRun(context([]))).toBe(false);
    // A marker that arrived after the last user message is the running prompt.
    expect(
      isInsideScheduledRun(
        context([
          { type: "message", message: { role: "user" } },
          { type: "message", message: { role: "assistant" } },
          { type: "custom", customType: "scheduled_prompt" },
        ]),
      ),
    ).toBe(true);
    // A marker from an earlier turn must not block a later add, however few
    // entries separate them.
    expect(
      isInsideScheduledRun(
        context([
          { type: "custom", customType: "scheduled_prompt" },
          { type: "message", message: { role: "user" } },
        ]),
      ),
    ).toBe(false);
    expect(
      isInsideScheduledRun(
        context([
          { type: "custom", customType: "scheduled_prompt" },
          ...Array.from({ length: 12 }, () => ({
            type: "message",
            message: { role: "assistant" },
          })),
          { type: "message", message: { role: "user" } },
        ]),
      ),
    ).toBe(false);
    // An unrelated custom entry is never a fired prompt.
    expect(isInsideScheduledRun(context([{ type: "custom", customType: "other" }]))).toBe(false);
  });
});

describe("cron tool", () => {
  test("add creates a job and reports its schedule and next run", async () => {
    const { hub, calls, state } = makeHub();
    const { text } = await callTool(hub, {
      action: "add",
      schedule: "every 5m",
      prompt: "check the deploy",
    });
    expect(calls).toContain("add");
    expect(text).toContain("Created cron job");
    expect(text).toContain("Next run:");
    expect(state.jobs.length).toBe(1);
    expect(state.jobs[0]?.createdBy).toBe(TEST_SESSION);
  });

  test("add leaves the job unowned when the creator session hosts no widget", async () => {
    const { hub, state } = makeHub();
    await callTool(
      hub,
      { action: "add", schedule: "every 5m", prompt: "check the deploy" },
      [],
      () => undefined,
    );
    expect(state.jobs[0]?.createdBy).toBeUndefined();
  });

  test("add rejects missing schedule or prompt with a readable error", async () => {
    const { hub } = makeHub();
    const missingPrompt = await callTool(hub, { action: "add", schedule: "5m" });
    expect(missingPrompt.text).toContain("`prompt` is required");
    const missingSchedule = await callTool(hub, { action: "add", prompt: "x" });
    expect(missingSchedule.text).toContain("`schedule` is required");
  });

  test("add refuses to schedule from inside a fired prompt", async () => {
    const { hub, calls } = makeHub();
    const { text } = await callTool(
      hub,
      { action: "add", schedule: "5m", prompt: "loop forever" },
      [{ type: "custom", customType: "scheduled_prompt" }],
    );
    expect(text).toContain("Refusing to schedule");
    expect(calls).not.toContain("add");
  });

  test("add rejects a duplicate job name", async () => {
    const { hub } = makeHub([job({ id: "a", name: "nightly" })]);
    const { text } = await callTool(hub, {
      action: "add",
      schedule: "5m",
      prompt: "x",
      name: "nightly",
    });
    expect(text).toContain('job named "nightly" already exists');
  });

  test("list summarises every job", async () => {
    const { hub } = makeHub([job({ id: "a", name: "nightly", nextRun: Date.now() + 60_000 })]);
    const { text, details } = await callTool(hub, { action: "list" });
    expect(text).toContain("Cron jobs (1)");
    expect(text).toContain("nightly");
    expect(details?.jobs.length).toBe(1);
  });

  test("list on an empty store says so instead of failing", async () => {
    const { hub } = makeHub();
    const { text } = await callTool(hub, { action: "list" });
    expect(text).toBe("No cron jobs configured.");
  });

  test("update patches the schedule and re-plans", async () => {
    const { hub, calls } = makeHub([job({ id: "a", name: "nightly" })]);
    const { text } = await callTool(hub, {
      action: "update",
      jobId: "a",
      schedule: "0 9 * * *",
      prompt: "new prompt",
    });
    expect(calls).toContain("update:a");
    expect(text).toContain("Updated cron job");
  });

  test("remove and enable/disable address a job by name", async () => {
    const { hub, calls } = makeHub([job({ id: "a", name: "nightly" })]);
    await callTool(hub, { action: "disable", jobId: "nightly" });
    expect(calls).toContain("update:a");
    await callTool(hub, { action: "remove", jobId: "nightly" });
    expect(calls).toContain("remove:a");
  });

  test("fire reports a skipped run when the hub declines the claim", async () => {
    const { hub } = makeHub([job({ id: "a", name: "nightly" })]);
    (hub as { fireNow: (id: string) => Promise<"done" | "skipped"> }).fireNow = async () =>
      "skipped";
    const { text, details } = await callTool(hub, { action: "fire", jobId: "a" });
    expect(text).toContain("already running");
    expect(details?.skipped).toBe(true);
  });

  test("actions on an unknown job return an error mentioning the key", async () => {
    const { hub } = makeHub();
    const { text, details } = await callTool(hub, { action: "fire", jobId: "ghost" });
    expect(text).toContain('No cron job matching "ghost"');
    expect(details?.error).toContain("ghost");
  });

  test("cleanup removes the paused jobs and reports the count", async () => {
    const { hub } = makeHub([
      job({ id: "a", name: "keep" }),
      job({ id: "b", name: "drop", enabled: false }),
    ]);
    const { text } = await callTool(hub, { action: "cleanup" });
    expect(text).toContain("Removed 1 paused job(s)");
    expect(text).toContain("drop");
  });
});
