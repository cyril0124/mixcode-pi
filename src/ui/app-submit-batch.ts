import * as path from "node:path";
import { applyBatchRequests, contextFromState, loadBatchRequests } from "../core/batch-lua.js";
import type { LocalCommand } from "../core/commands.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import { type LocalCommandHandler, SKIP_FINALIZE } from "./app-types.js";
import { createBatchExecutorHost, runBatchActionWithSave } from "./batch-host.js";

// Independent tab groups and repeated invocations share one ordered save chain.
// A failed save is surfaced to its caller; later saves must still be attempted.
const pendingSaves = new WeakMap<MixCodeState, Promise<void>>();

const handleBatch: LocalCommandHandler = async ({
  state,
  runtime,
  active,
  rawArgs,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  const persist = () => {
    const write = async () => {
      await onStateChanged?.(state);
    };
    const pending = pendingSaves.get(state) ?? Promise.resolve();
    const next = pending.then(write, write);
    pendingSaves.set(state, next);
    return next;
  };
  try {
    const { file, args } = parseBatchArguments(rawArgs);
    const workdir = state.activeTabId === HOME_TAB_ID ? state.workdir : active!.workdir;
    // Capture before evaluation yields; subsequent UI changes leave this snapshot intact.
    const plan = await loadBatchRequests(path.resolve(workdir, file), {
      ...contextFromState(state),
      workdir,
      args,
    });
    const requests = plan.requests.map((request) => ({
      ...request,
      workdir: path.resolve(workdir, request.workdir ?? "."),
    }));
    for (const request of requests) {
      if (state.tabs.find((tab) => tab.title === request.name)?.status === "Not Ready") {
        throw new Error(`Error: Batch tab is still loading: ${request.name}`);
      }
    }
    const host = createBatchExecutorHost({ state, runtime, tui, onStateChanged: persist });
    await runBatchActionWithSave(
      () => applyBatchRequests(requests, host),
      async () => {
        // Other groups can still settle and save after apply rejects.
        await persist();
        tui.requestRender();
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith("Error:") ? message : `Error: ${message}`, { cause: error });
  }
  return SKIP_FINALIZE;
};

export const BATCH_COMMAND_HANDLERS = {
  batch: handleBatch,
} satisfies Partial<Record<LocalCommand, LocalCommandHandler>>;

/** Quotes group literal arguments; backslash escapes outside single quotes.
 * Empty quoted arguments survive. No variable, command, or glob expansion runs.
 * Unclosed quotes, trailing escapes, and missing separators fail before loading.
 */
function parseBatchArguments(input: string): { file: string; args: string[] } {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === "\\" && quote !== "'") {
      index++;
      if (index === input.length)
        throw new Error("Error: Invalid batch arguments: trailing escape");
      token += input[index];
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Error: Invalid batch arguments: unclosed quote");
  if (started) tokens.push(token);
  const [file, separator, ...args] = tokens;
  if (!file || file === "--" || (separator !== undefined && separator !== "--")) {
    throw new Error("Error: Usage: /batch <script> [-- <args...>]");
  }
  return { file, args };
}
