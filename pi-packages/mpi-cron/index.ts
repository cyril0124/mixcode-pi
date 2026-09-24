/**
 * mpi-cron: schedule prompts on a per-directory job store.
 *
 * Jobs live in `<cwd>/<CONFIG_DIR_NAME>/cron/jobs.json`, not inside a session
 * file, so a job created by another tab or a subagent keeps firing and survives a
 * restart. A tab's widget shows the jobs that tab created plus the jobs no tab
 * owns: those stored before `createdBy` existed, and those a subagent created,
 * since a subagent session hosts no widget. Firing claims the job in the store
 * first, so several tabs, or several `mpi` processes in one directory, deliver a
 * run exactly once. The surfaces are the `cron` tool for agents and `/cron` for
 * interactive management.
 *
 * Delivery target: a fired prompt prefers the session that created the job, so a
 * run reports back to the tab where it was set up, and falls back to the first
 * interactive tab when that session has exited. The store's claim keeps a run
 * from being delivered twice by the other tabs.
 */

import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { CronManagementView } from "./cron-management-view.js";
import { CRON_WIDGET_ID, renderCronWidgetRows, WIDGET_REFRESH_MS } from "./cron-widget.js";
import type { CronHub } from "./hub.js";
import { getCronHub } from "./hub.js";
import { CronStore } from "./storage.js";
import { createCronTool, findJob, SCHEDULED_PROMPT_TYPE } from "./tool.js";
import type { CronInstance, CronJob } from "./types.js";

/**
 * pi-subagents names a child session `<type>#<8 chars of the agent id>`. A name
 * matching this shape marks a subagent session: it may create and read jobs, but
 * it owns no timers and no widget, which belong to the parent session.
 */
const SUBAGENT_SESSION_NAME = /^[^#\s]+#[0-9A-Za-z]{8}$/;

/** Marker payload for a fired or finished job. */
interface ScheduledPromptData {
  job?: string;
  name?: string;
  state?: "fired" | "ok" | "error";
  text?: string;
  /** Body field used by entries recorded before `text` existed. */
  prompt?: string;
}

function isSubagentSession(ctx: ExtensionContext): boolean {
  const name = ctx.sessionManager.getSessionName();
  return name !== undefined && SUBAGENT_SESSION_NAME.test(name);
}

/**
 * Render a `scheduled_prompt` entry: job name, state, and the run output.
 */
const scheduledPromptRenderer: EntryRenderer<ScheduledPromptData> = (entry, _options, theme) => {
  const data = entry.data ?? {};
  const container = new Container();
  const state = data.state === "error" ? "failed" : data.state === "ok" ? "finished" : "fired";
  const tone = data.state === "error" ? "error" : "accent";
  container.addChild(
    new Text(
      `${theme.fg(tone, "cron")} ${theme.fg("text", data.name ?? data.job ?? "scheduled job")} ${theme.fg("dim", state)}`,
      0,
      0,
    ),
  );
  const body = data.text ?? data.prompt;
  if (body) {
    const text = body.replace(/[\r\n]+/g, " ").trim();
    if (text) container.addChild(new Text(theme.fg("dim", text), 2, 0));
  }
  return container;
};

/** One tab's owned state. Per-tab, because this module instance is shared. */
interface TabState {
  instance: CronInstance;
  context: ExtensionContext;
  /** Latest job snapshot, so a repaint needs no await. */
  jobs: CronJob[];
  timer?: ReturnType<typeof setInterval>;
}

/** Per-session transcript writer for run markers. */
interface MarkerWriter {
  append: (data: ScheduledPromptData) => void;
  /** False for subagent sessions, which never receive a run. */
  interactive: boolean;
}

const MARKER_KEY = Symbol.for("mpi-cron.markers");

/**
 * Process-wide map of session id to transcript writer. Pi calls the extension
 * factory once per session, so a factory-local map holds one tab only; a run
 * delivered into another tab would have its marker written into this one. The
 * hub uses the same `globalThis` symbol key for the same reason.
 */
function markerWriters(): Map<string, MarkerWriter> {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[MARKER_KEY];
  if (existing instanceof Map) return existing as Map<string, MarkerWriter>;
  const created = new Map<string, MarkerWriter>();
  registry[MARKER_KEY] = created;
  return created;
}

export default function mpiCron(pi: ExtensionAPI) {
  const tabs = new Map<string, TabState>();
  let hub: CronHub | undefined;
  let storeCwd: string | undefined;

  const ensureHub = (cwd: string): CronHub => {
    if (hub) return hub;
    storeCwd = cwd;
    hub = getCronHub({
      store: new CronStore({ cwd }),
      onChange: () => {
        for (const tab of tabs.values()) {
          if (tab.instance.isSubagent) continue;
          void tab.instance.refresh();
        }
      },
      onRunFinished: ({ job, status, detail, sessionId }) => {
        // The marker belongs in the session that received the prompt, so it sits
        // next to what it reports on. When that session has exited, the first
        // interactive tab takes it instead.
        const writers = markerWriters();
        const target =
          (sessionId !== undefined ? writers.get(sessionId) : undefined) ??
          [...writers.values()].find((writer) => writer.interactive);
        target?.append({
          job: job.id,
          name: job.name,
          state: status,
          text: detail.trim() ? detail.trim().slice(0, 400) : "(no output)",
        });
      },
    });
    return hub;
  };

  pi.registerTool(
    createCronTool(
      () => ensureHub(storeCwd ?? process.cwd()),
      // A subagent session hosts no widget, so its jobs stay unowned and show in
      // the interactive tabs instead of disappearing from every widget.
      (ctx) => (isSubagentSession(ctx) ? undefined : ctx.sessionManager.getSessionId()),
    ),
  );

  pi.registerCommand("cron", {
    description: "Show and manage scheduled cron jobs. Usage: /cron [stop <id|name>]",
    ...({ argumentHint: "[stop <id|name>]" } as Record<string, unknown>),
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trim();
      if (!trimmed) {
        return [
          { label: "stop <id|name>", description: "Remove a job by id or name", value: "stop " },
        ];
      }
      if (trimmed.startsWith("stop")) {
        const jobs = hub?.cachedJobs() ?? [];
        if (jobs.length === 0) return null;
        return jobs.map((job) => ({
          label: `${job.id} (${job.name})`,
          description: job.prompt.slice(0, 60),
          value: `stop ${job.id}`,
        }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const cronHub = ensureHub(ctx.cwd);
      const trimmed = args.trim();

      // ── stop subcommand ──────────────────────────────────────────────────
      if (trimmed.startsWith("stop")) {
        const idOrName = trimmed.slice(4).trim();
        if (!idOrName) {
          ctx.ui.notify("Error: Usage: /cron stop <id|name>", "warning");
          return;
        }
        const jobs = await cronHub.refresh();
        const job = findJob(jobs, idOrName);
        if (!job) {
          ctx.ui.notify(
            `Error: No job found: "${idOrName}". Use /cron to see all jobs.`,
            "warning",
          );
          return;
        }
        await cronHub.remove(job.id);
        await refreshTabs(cronHub);
        ctx.ui.notify(`Job "${job.name}" (${job.id}) removed.`, "info");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const tab = tabs.get(sessionId);
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new CronManagementView(
            theme,
            () => tui.requestRender(),
            () => done(undefined),
            () => Math.floor(tui.terminal.rows * 0.8),
            {
              getJobs: () => tab?.jobs ?? [],
              add: async (input) => {
                const createdBy = tab?.instance.isSubagent ? undefined : sessionId;
                const job = await cronHub.add({ ...input, createdBy });
                if (tab) tab.jobs = await cronHub.refresh();
                return job;
              },
              setEnabled: async (id, enabled) => {
                await cronHub.update(id, { enabled });
              },
              fireNow: async (id) => {
                await cronHub.fireNow(id);
              },
              remove: async (id) => {
                await cronHub.remove(id);
              },
              cleanup: async () => {
                const jobs = await cronHub.refresh();
                const paused = jobs.filter((job) => !job.enabled);
                for (const job of paused) await cronHub.remove(job.id);
                return paused.length;
              },
            },
          ),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%", margin: 1 },
        },
      );
      // The overlay mutated the store; republish a fresh snapshot for the widget.
      await refreshTabs(cronHub);
    },
  });

  /** Re-read the store and repaint every tab's widget. */
  const refreshTabs = async (cronHub: CronHub): Promise<void> => {
    if (tabs.size === 0) return;
    const jobs = await cronHub.refresh();
    for (const tab of tabs.values()) {
      tab.jobs = jobs;
      if (!tab.instance.isSubagent) renderWidget(tab);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const cronHub = ensureHub(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const subagent = isSubagentSession(ctx);
    const tab: TabState = {
      context: ctx,
      jobs: [],
      instance: {
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        parentSession: ctx.sessionManager.getHeader()?.parentSession,
        sessionName: ctx.sessionManager.getSessionName(),
        isSubagent: subagent,
        cwd: ctx.cwd,
        isIdle: () => ctx.isIdle(),
        deliver: (prompt) => deliverIntoSession(pi, ctx, prompt),
        refresh: async () => {
          tab.jobs = await cronHub.refresh();
          renderWidget(tab);
        },
      },
    };
    tabs.set(sessionId, tab);
    markerWriters().set(sessionId, {
      append: (data) => {
        try {
          pi.appendEntry<ScheduledPromptData>(SCHEDULED_PROMPT_TYPE, data);
        } catch {
          // A context that went stale mid-run cannot take the marker; the store
          // already holds the outcome, so swallowing this is safe.
        }
      },
      interactive: !subagent,
    });

    if (subagent) return;
    tab.jobs = await cronHub.refresh();
    cronHub.register(tab.instance);
    renderWidget(tab);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const tab = tabs.get(sessionId);
    stopWidget(tab);
    tabs.delete(sessionId);
    markerWriters().delete(sessionId);
    // A subagent never registered, and unregister is a no-op for unknown ids.
    hub?.unregister(sessionId);
  });

  pi.registerEntryRenderer(SCHEDULED_PROMPT_TYPE, scheduledPromptRenderer);
}

/**
 * Inject a fired prompt. `expandPromptTemplates` matches typed input, so a job
 * may hold `/command`, `$skill`, or a prompt template; a busy agent receives the
 * prompt as a follow-up rather than losing it.
 */
function deliverIntoSession(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): boolean {
  try {
    if (ctx.isIdle()) pi.sendUserMessage(prompt, { expandPromptTemplates: true });
    else pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
    return true;
  } catch {
    // A replaced session throws here; the caller drops the instance and plans the
    // next run instead of reporting a delivery it did not make.
    return false;
  }
}

/** Register or refresh this tab's widget from its current job snapshot. */
function renderWidget(tab: TabState): void {
  const { context } = tab;
  // Show the jobs this tab created, so the widget does not appear in unrelated
  // tabs. A job with no createdBy (stored before the field existed, or created by
  // a subagent session, which hosts no widget) is shown in every tab.
  const jobs = tab.jobs.filter(
    (j) => j.createdBy === undefined || j.createdBy === tab.instance.sessionId,
  );
  try {
    if (jobs.length === 0) {
      context.ui.setWidget(CRON_WIDGET_ID, undefined);
      stopWidget(tab);
      return;
    }
    context.ui.setWidget(
      CRON_WIDGET_ID,
      (_tui, theme: Theme) => ({
        render: (width: number) => renderCronWidgetRows(jobs, width, theme, Date.now()),
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );
    // The relative-time column has to advance while the session sits quiet.
    tab.timer ??= setInterval(() => {
      try {
        renderWidget(tab);
      } catch {
        stopWidget(tab);
      }
    }, WIDGET_REFRESH_MS);
    tab.timer.unref?.();
  } catch {
    // A replaced session leaves a stale context behind; stop repainting and let
    // the next session_start register a fresh widget.
    stopWidget(tab);
  }
}

function stopWidget(tab: TabState | undefined): void {
  if (!tab?.timer) return;
  clearInterval(tab.timer);
  tab.timer = undefined;
}
