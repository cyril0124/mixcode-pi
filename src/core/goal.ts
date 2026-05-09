import type { GoalState, MixCodeTabInfo } from "./types.js";

export const GOAL_COMPLETION_MARKER = "MIXCODE_GOAL_COMPLETE";

export type GoalAction = "set" | "pause" | "resume" | "complete" | "clear" | "status";

export interface GoalActionResult {
  message: string;
  prompt?: string;
}

export function applyGoalAction(
  tab: MixCodeTabInfo,
  rawAction: string,
  text = "",
  now = new Date(),
): GoalActionResult {
  const action = normalizeGoalAction(rawAction);
  const objective = text.trim();
  if (action === "status") {
    return { message: renderGoalStatus(tab.goal) };
  }
  if (action === "set") {
    if (!objective) throw new Error("Goal objective cannot be empty");
    tab.goal = createGoal(objective, now);
    return { message: `Goal active: ${objective}`, prompt: buildGoalPrompt("set", objective) };
  }
  if (action === "resume") {
    const resumedObjective = objective || tab.goal?.objective.trim() || "";
    if (!resumedObjective) throw new Error("No goal to resume");
    tab.goal = {
      objective: resumedObjective,
      status: "active",
      createdAt: tab.goal?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      lastError: tab.goal?.lastError || "",
      lastErrorAt: tab.goal?.lastErrorAt || "",
    };
    return {
      message: `Goal resumed: ${resumedObjective}`,
      prompt: buildGoalPrompt("resume", resumedObjective),
    };
  }
  if (action === "pause") {
    const goal = requireGoal(tab, "pause");
    tab.goal = { ...goal, status: "paused", updatedAt: now.toISOString() };
    return { message: `Goal paused: ${goal.objective}` };
  }
  if (action === "complete") {
    const goal = requireGoal(tab, "complete");
    tab.goal = { ...goal, status: "complete", updatedAt: now.toISOString() };
    return { message: `Goal complete: ${goal.objective}` };
  }
  if (action === "clear") {
    const objective = tab.goal?.objective || "";
    tab.goal = undefined;
    return { message: objective ? `Goal cleared: ${objective}` : "Goal cleared." };
  }
  throw new Error(`Unknown goal action: ${rawAction}`);
}

export function parseGoalCommandArgs(args: string): { action: GoalAction; text: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status", text: "" };
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const lowered = first.toLowerCase();
  if (
    lowered === "status" ||
    lowered === "set" ||
    lowered === "pause" ||
    lowered === "resume" ||
    lowered === "complete" ||
    lowered === "clear"
  ) {
    return { action: lowered, text: rest.join(" ") };
  }
  return { action: "set", text: trimmed };
}

export function buildGoalPrompt(action: "set" | "resume", objective: string): string {
  const lead =
    action === "resume"
      ? "Resume working toward this MixCode goal."
      : "Start working toward this MixCode goal.";
  return [
    lead,
    "",
    "Goal:",
    objective,
    "",
    "When the goal is fully complete, include this exact standalone line in your final response:",
    GOAL_COMPLETION_MARKER,
  ].join("\n");
}

export function consumeGoalCompletionMarker(
  tab: MixCodeTabInfo,
  text: string,
  now = new Date(),
): string {
  if (!hasGoalCompletionMarker(text) || !tab.goal || tab.goal.status === "complete") return text;
  tab.goal = { ...tab.goal, status: "complete", updatedAt: now.toISOString() };
  return text;
}

export function renderGoalSummary(goal: GoalState | undefined, width = 64): string {
  if (!goal?.objective.trim()) return "";
  const prefix = `Goal ${normalizeGoalStatus(goal.status)}: `;
  const objective = goal.objective.replace(/\s+/g, " ").trim();
  const maxObjective = Math.max(0, width - prefix.length);
  if (maxObjective <= 0) return "";
  return `${prefix}${objective.length > maxObjective ? `${objective.slice(0, Math.max(0, maxObjective - 1)).trimEnd()}...` : objective}`;
}

export function normalizeGoal(value: unknown): GoalState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const objective = String(data.objective ?? "").trim();
  const status = normalizeGoalStatus(data.status);
  if (!objective && status !== "error") return undefined;
  return {
    objective,
    status,
    createdAt: String(data.createdAt ?? data.created_at ?? ""),
    updatedAt: String(data.updatedAt ?? data.updated_at ?? ""),
    lastError: String(data.lastError ?? data.last_error ?? ""),
    lastErrorAt: String(data.lastErrorAt ?? data.last_error_at ?? ""),
  };
}

function createGoal(objective: string, now: Date): GoalState {
  const timestamp = now.toISOString();
  return {
    objective,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: "",
    lastErrorAt: "",
  };
}

function renderGoalStatus(goal: GoalState | undefined): string {
  if (!goal) return "No active goal.";
  const summary = renderGoalSummary(goal, 120);
  return [
    summary,
    `created: ${goal.createdAt || "unknown"}`,
    `updated: ${goal.updatedAt || "unknown"}`,
  ].join("\n");
}

function normalizeGoalAction(action: string): GoalAction {
  const normalized = action.trim().toLowerCase();
  if (
    normalized === "status" ||
    normalized === "set" ||
    normalized === "pause" ||
    normalized === "resume" ||
    normalized === "complete" ||
    normalized === "clear"
  )
    return normalized;
  throw new Error(`Unknown goal action: ${action}`);
}

function normalizeGoalStatus(status: unknown): GoalState["status"] {
  return status === "paused" || status === "complete" || status === "error" ? status : "active";
}

function requireGoal(tab: MixCodeTabInfo, action: string): GoalState {
  if (!tab.goal) throw new Error(`No goal to ${action}`);
  return tab.goal;
}

function hasGoalCompletionMarker(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((line, index) => {
    if (line.trim() !== GOAL_COMPLETION_MARKER) return false;
    const previous = lines[index - 1]?.toLowerCase() ?? "";
    return (
      !previous.includes("include this exact standalone line") &&
      !previous.includes("final response")
    );
  });
}
