import type { PromptContextMessage } from "../agent/runtime-prompt-context.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandTilde, mpiCtlSkillPath } from "./paths.js";
import type { MixCodeTabInfo } from "./types.js";

type ReferenceTab = Pick<MixCodeTabInfo, "title" | "sessionId">;
type PromptTarget = ReferenceTab & Pick<MixCodeTabInfo, "workdir">;

export interface PreparedTabReferencePrompt {
  text: string;
  contextMessages: PromptContextMessage[];
}

const pendingPreparations = new WeakMap<PromptTarget, Promise<PreparedTabReferencePrompt>>();

const CONTEXT_START = "\n\n<mpi-tab-references>\n";
const CONTEXT_END = "\n</mpi-tab-references>";
const INSTRUCTION =
  "These references identify live MixCode agent tabs. Before inspecting or interacting with a tab, read the skill at the supplied path. Verify the target with mpi status --json, then use mpi ctl with --pid and --session. Send a message only when the user's request calls for one. If a target has closed, report it as unavailable. Do not substitute another tab.";

/**
 * Return the original editor text and separate hidden context for references to peer tabs.
 * Match titles against the supplied instance snapshot and check each matched title once
 * for a filesystem conflict. Calls for the same target prepare in submission order.
 * Reject ambiguous titles, file conflicts, and failed probes with Error:-prefixed errors.
 * Tab state, editor text, and history remain unchanged. This function sends no messages.
 */
export function prepareTabReferencePrompt(
  text: string,
  tabs: readonly ReferenceTab[],
  target: PromptTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreparedTabReferencePrompt> {
  // Capture titles before I/O and serialize preparation per recipient. A later
  // prompt must wait for earlier filesystem checks, even if it has no references.
  const snapshot = text.includes("@")
    ? tabs.map(({ title, sessionId }) => ({ title, sessionId }))
    : [];
  const destination = { title: target.title, sessionId: target.sessionId, workdir: target.workdir };
  const prepare = () => buildReferencePrompt(text, snapshot, destination, env);
  const previous = pendingPreparations.get(target);
  // The caller receives the error. A failed preparation still releases the next input.
  const pending = previous ? previous.then(prepare, prepare) : prepare();
  pendingPreparations.set(target, pending);
  const clear = () => {
    if (pendingPreparations.get(target) === pending) pendingPreparations.delete(target);
  };
  void pending.then(clear, clear);
  return pending;
}

async function buildReferencePrompt(
  text: string,
  tabs: readonly ReferenceTab[],
  target: PromptTarget,
  env: NodeJS.ProcessEnv,
): Promise<PreparedTabReferencePrompt> {
  const plain = { text, contextMessages: [] };
  if (!text.includes("@") || /^[\s]*[!/]/.test(text)) return plain;

  const titles = mentionedTitles(text);
  if (titles.size === 0) return plain;
  const byTitle = new Map<string, ReferenceTab[]>();
  for (const tab of tabs) {
    if (tab.sessionId === target.sessionId || !titles.has(tab.title)) continue;
    const matches = byTitle.get(tab.title);
    if (matches) matches.push(tab);
    else byTitle.set(tab.title, [tab]);
  }

  const references = new Map<string, ReferenceTab>();
  for (const title of titles) {
    const matches = byTitle.get(title);
    if (!matches) continue;
    if (matches.length > 1) {
      throw new Error(
        `Error: Ambiguous tab reference ${JSON.stringify(title)}. Rename the tabs to distinct titles and select again.`,
      );
    }
    const candidatePath = path.resolve(target.workdir, expandTilde(title));
    let exists: boolean;
    try {
      await fs.lstat(candidatePath);
      exists = true;
    } catch (error) {
      // Missing entries (including a non-directory path prefix) cannot collide with a tab.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(
          `Error: Cannot check file conflict for tab ${JSON.stringify(title)}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      exists = false;
    }
    if (exists) {
      throw new Error(
        `Error: File or directory conflicts with tab reference ${JSON.stringify(title)}. Use an explicit file path, or rename the tab and select again.`,
      );
    }
    const match = matches[0]!;
    references.set(match.sessionId, match);
  }
  if (references.size === 0) return plain;

  const context = {
    instruction: INSTRUCTION,
    skill: mpiCtlSkillPath(env),
    targets: [...references.values()].map((tab) => ({
      title: tab.title,
      pid: process.pid,
      sessionId: tab.sessionId,
    })),
  };
  // Titles are data. Escaping angle brackets prevents them from terminating the wrapper.
  const serialized = JSON.stringify(context, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return {
    text,
    contextMessages: [
      {
        customType: "tab-references",
        content: `${CONTEXT_START.trimStart()}${serialized}${CONTEXT_END}`,
        display: false,
      },
    ],
  };
}

function mentionedTitles(text: string): Set<string> {
  const titles = new Set<string>();
  let fence: { character: string; length: number } | undefined;
  let inlineTicks = 0;
  // Match the completion provider's delimiters; a quoted title is JSON-decoded below.
  const tokens = /(`+)|(?:^|[\s"'=])@("(?:\\.|[^"\\])*"|[^\s"'=`]+)/g;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        fenceMatch?.[1]?.[0] === fence.character &&
        fenceMatch[1].length >= fence.length &&
        !fenceMatch[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = { character: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      inlineTicks = 0;
      continue;
    }
    if (!line.trim()) inlineTicks = 0;
    for (const token of line.matchAll(tokens)) {
      if (token[1]) {
        if (inlineTicks === 0) inlineTicks = token[1].length;
        else if (inlineTicks === token[1].length) inlineTicks = 0;
        continue;
      }
      if (inlineTicks > 0) continue;
      const value = token[2]!;
      if (!value.startsWith('"')) {
        titles.add(value);
        continue;
      }
      try {
        titles.add(JSON.parse(value) as string);
      } catch (error) {
        // Incomplete or invalid quoted mentions are ordinary input, not a target guess.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return titles;
}
