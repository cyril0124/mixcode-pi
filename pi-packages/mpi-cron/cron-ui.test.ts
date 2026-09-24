/**
 * UI contract tests for the widget rows and the management view: correct summary
 * of job state, no width overflow with CJK names, and the documented key
 * bindings. Rendering runs for real; the theme is a pass-through stub, so the
 * assertions read plain text.
 */

import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CronManagementView } from "./cron-management-view.js";
import { renderCronWidgetRows, sortJobs } from "./cron-widget.js";
import type { CronJob } from "./types.js";

/** Pass-through theme: every styling call returns its input unchanged. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function job(overrides: Partial<CronJob> & { id: string }): CronJob {
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

describe("renderCronWidgetRows", () => {
  const now = 1_700_000_000_000;

  test("hides itself when there are no jobs", () => {
    expect(renderCronWidgetRows([], 80, plainTheme, now)).toEqual([]);
  });

  test("shows status, schedule, next run, and run count for each job", () => {
    const rows = renderCronWidgetRows(
      [
        job({ id: "a", name: "daily", nextRun: now + 3_600_000, runCount: 41 }),
        job({
          id: "b",
          name: "hourly",
          enabled: false,
          runCount: 2,
          schedule: { kind: "cron", expr: "0 * * * *", source: "0 * * * *" },
        }),
      ],
      80,
      plainTheme,
      now,
    );
    const text = rows.join("\n");
    expect(text).toContain("Cron (2)");
    expect(text).toContain("daily");
    expect(text).toContain("in 1h00m");
    expect(text).toContain("41 runs");
    expect(text).toContain("hourly");
    expect(text).toContain("paused");
  });

  test("marks a running job and a failed last run", () => {
    const rows = renderCronWidgetRows(
      [
        job({ id: "run", name: "running-job", claim: "token" }),
        job({ id: "bad", name: "failing-job", lastStatus: "error", nextRun: now + 1_000 }),
      ],
      80,
      plainTheme,
      now,
    );
    const text = rows.join("\n");
    expect(text).toContain("running");
    expect(text).toContain("failing-job");
  });

  test("caps the visible rows and reports the hidden count", () => {
    const jobs = Array.from({ length: 9 }, (_, index) =>
      job({ id: `j${index}`, name: `job-${index}`, nextRun: now + 1_000 * (index + 1) }),
    );
    const rows = renderCronWidgetRows(jobs, 80, plainTheme, now);
    expect(rows.join("\n")).toContain("3 more");
  });

  test("never exceeds the requested width, including with CJK names", () => {
    for (const width of [90, 60, 40, 24]) {
      const rows = renderCronWidgetRows(
        [
          job({
            id: "cjk",
            name: "每日构建检查与部署状态汇总",
            nextRun: now + 90_000,
            schedule: { kind: "cron", expr: "*/15 * * * *", source: "*/15 * * * *" },
          }),
        ],
        width,
        plainTheme,
        now,
      );
      for (const line of rows) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("sorts enabled jobs first, then by next run", () => {
    const late = job({ id: "late", nextRun: now + 9_000 });
    const soon = job({ id: "soon", nextRun: now + 1_000 });
    const paused = job({ id: "paused", enabled: false, nextRun: now + 500 });
    expect(sortJobs([late, paused, soon]).map((entry) => entry.id)).toEqual([
      "soon",
      "late",
      "paused",
    ]);
  });
});

/** Harness for the management view: a mutable job list plus recorded actions. */
function makeView(initial: CronJob[], maxHeight = 24) {
  const state = { jobs: initial };
  const calls: string[] = [];
  const view = new CronManagementView(
    plainTheme,
    () => {},
    () => calls.push("done"),
    () => maxHeight,
    {
      getJobs: () => state.jobs,
      add: async (input) => {
        calls.push("add");
        const created = job({
          id: `new-${state.jobs.length + 1}`,
          ...input,
          schedule: input.schedule ??
            state.jobs[0]?.schedule ?? { kind: "interval", intervalMs: 300_000, source: "5m" },
        });
        state.jobs.push(created);
        return created;
      },
      setEnabled: (id, enabled) => {
        calls.push(`setEnabled:${id}:${enabled}`);
      },
      fireNow: (id) => {
        calls.push(`fire:${id}`);
      },
      remove: (id) => {
        calls.push(`remove:${id}`);
      },
      cleanup: () => {
        calls.push("cleanup");
        return 0;
      },
    },
  );
  return { view, calls, state };
}

describe("CronManagementView", () => {
  test("renders a bordered panel listing the jobs", () => {
    const { view } = makeView([job({ id: "a", name: "daily", nextRun: Date.now() + 60_000 })]);
    const rows = view.render(60);
    expect(rows[0]).toContain("┌");
    expect(rows[0]).toContain("Cron jobs (1)");
    expect(rows.join("\n")).toContain("daily");
    expect(rows[rows.length - 1]).toContain("┘");
  });

  test("deleting asks for confirmation and only y acts", () => {
    const { view, calls } = makeView([job({ id: "a", name: "daily" })]);
    view.handleInput("d");
    expect(view.render(60).join("\n")).toContain("Remove cron job");
    // Any other key cancels; "d" must not delete a second time without a "y".
    view.handleInput("d");
    expect(calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
    view.handleInput("d");
    view.handleInput("y");
    expect(calls).toContain("remove:a");
  });

  test("space toggles the selected job, f fires it, and q closes", async () => {
    const { view, calls } = makeView([job({ id: "a", name: "daily", enabled: true })]);
    view.handleInput(" ");
    // Actions are serialized: a second key is ignored until the first store call
    // settles, which is what keeps two fast keypresses from double-firing.
    await Bun.sleep(0);
    view.handleInput("f");
    await Bun.sleep(0);
    expect(calls).toContain("setEnabled:a:false");
    expect(calls).toContain("fire:a");
    view.handleInput("q");
    expect(calls).toContain("done");
  });

  test("shows how long ago each job last ran, and flags a failed last run", () => {
    const { view } = makeView([
      job({ id: "a", name: "recent", lastRun: Date.now() - 120_000, lastStatus: "ok" }),
      job({ id: "b", name: "broken", lastRun: Date.now() - 120_000, lastStatus: "error" }),
      job({ id: "c", name: "fresh" }),
    ]);
    const text = view.render(80).join("\n");
    expect(text).toContain("last 2m00s ago");
    expect(text).toContain("never run");
    expect(text).toContain("! broken");
  });

  test("filters with typed text and clears with ctrl+u", () => {
    const { view } = makeView([
      job({ id: "a", name: "alpha", nextRun: Date.now() + 1_000 }),
      job({ id: "b", name: "beta", nextRun: Date.now() + 2_000 }),
    ]);
    view.handleInput("b");
    let text = view.render(60).join("\n");
    expect(text).toContain("beta");
    expect(text).not.toContain("alpha");
    view.handleInput("\u0015");
    text = view.render(60).join("\n");
    expect(text).toContain("alpha");
  });

  test("cleanup is offered only while a paused job exists, and needs confirmation", () => {
    const enabledOnly = makeView([job({ id: "a", name: "daily", enabled: true })]);
    enabledOnly.view.handleInput("c");
    expect(enabledOnly.calls).not.toContain("cleanup");

    const withPaused = makeView([job({ id: "a", name: "daily", enabled: false })]);
    withPaused.view.handleInput("c");
    expect(withPaused.view.render(60).join("\n")).toContain("finished jobs");
    expect(withPaused.calls).not.toContain("cleanup");
    withPaused.view.handleInput("n");
    expect(withPaused.calls).not.toContain("cleanup");
    withPaused.view.handleInput("c");
    withPaused.view.handleInput("y");
    expect(withPaused.calls).toContain("cleanup");
  });

  test("renders within the requested width for narrow terminals", () => {
    const { view } = makeView([job({ id: "a", name: "每日部署检查报告" })]);
    for (const width of [60, 40, 20]) {
      for (const line of view.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("fills every surface to the panel width without truncating content", () => {
    const entry = job({
      id: "a",
      name: "deploy check",
      runCount: 3,
      nextRun: Date.now() + 1_800_000,
      lastRun: Date.now() - 7_205_000,
      lastStatus: "ok",
    });
    for (const width of [60, 100]) {
      const { view } = makeView([entry], 30);
      const surfaces: Array<[string, string[]]> = [["list", view.render(width)]];
      view.handleInput("\r");
      surfaces.push(["detail", view.render(width)]);
      view.handleInput("\u001b");
      view.handleInput("d");
      surfaces.push(["confirm", view.render(width)]);
      view.handleInput("\u001b");
      view.handleInput("n");
      surfaces.push(["add", view.render(width)]);
      const labeled: Array<[string, string]> = surfaces.flatMap(([label, lines]) =>
        lines.map((line) => [label, line] as [string, string]),
      );
      expect(labeled.filter(([, line]) => line.includes("…"))).toEqual([]);
      expect(labeled.filter(([, line]) => visibleWidth(line) !== width)).toEqual([]);
    }
  });
});
