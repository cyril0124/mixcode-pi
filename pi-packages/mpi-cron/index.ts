/**
 * mpi-cron: schedule prompts on a per-directory job store.
 *
 * Jobs live in `<cwd>/<CONFIG_DIR_NAME>/cron/jobs.json`, not inside a session
 * file, so a job created by a subagent or another tab appears in every tab's
 * widget and survives a restart. Firing claims the job in the store first, so
 * several tabs, or several `mpi` processes in one directory, deliver a run
 * exactly once. The surfaces are the `cron` tool for agents and `/cron` for
 * interactive management.
 *
 * Delivery target: Pi binds one extension runner per session, and the loader
 * caches one module instance per cwd, so this module sees every tab's context but
 * only the active runner can inject a message. A fired prompt therefore lands in
 * the session that is currently active; the store's claim keeps it from being
 * delivered twice by the other tabs.
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
import { createCronTool, SCHEDULED_PROMPT_TYPE } from "./tool.js";
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
      onRunFinished: ({ job, status, detail }) => {
        // The hub does not track which tab received the prompt, so the marker
        // goes to the first interactive tab.
        const ctx = [...tabs.values()].find((tab) => !tab.instance.isSubagent)?.context;
        if (!ctx) return;
        try {
          pi.appendEntry<ScheduledPromptData>(SCHEDULED_PROMPT_TYPE, {
            job: job.id,
            name: job.name,
            state: status,
            text: detail.trim() ? detail.trim().slice(0, 400) : "(no output)",
          });
        } catch {
          // A session that vanished mid-run cannot record the marker; the store
          // already holds the outcome, so this is not a failed run.
        }
      },
    });
    return hub;
  };

  pi.registerTool(createCronTool(() => ensureHub(storeCwd ?? process.cwd())));

  pi.registerCommand("cron", {
    description: "Show and manage scheduled cron jobs. Usage: /cron",
    handler: async (_args, ctx) => {
      const cronHub = ensureHub(ctx.cwd);
      const tab = tabs.get(ctx.sessionManager.getSessionId());
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
                const job = await cronHub.add(input);
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
  const { context, jobs } = tab;
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
