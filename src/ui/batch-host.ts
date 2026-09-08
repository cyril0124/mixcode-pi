import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { BatchExecutorHost, BatchTabRequest } from "../core/batch-lua.js";
import { applyContextLimitToSession } from "../core/context-limit.js";
import { parseInput } from "../core/commands.js";
import { assertModelEnabled, findModelRef } from "../core/models.js";
import type { MixCodeState } from "../core/types.js";
import {
  createAgentTab,
  deleteAgentTab,
  resetAgentTab,
  submitAgentInput,
} from "./agent-tab-actions.js";
import { applyModelSelection, applyThinkingLevel } from "./app-actions.js";
import type { OverlayTui } from "./app-types.js";

/**
 * Adapt batch requests to shared TUI tab actions. Resolve title/model overrides
 * here; delegate reset, deletion, and prompt dispatch to the shared actions.
 * Optional persistence is awaited after mutations and settled submissions,
 * including failed turns. Without it, startup retains its existing save policy.
 */
export function createBatchExecutorHost(options: {
  state: MixCodeState;
  runtime: MixCodeRuntime;
  tui: Pick<OverlayTui, "requestRender">;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
}): BatchExecutorHost {
  const { state, runtime, tui, onStateChanged } = options;
  const persist = async () => {
    await onStateChanged?.(state);
    tui.requestRender();
  };
  return {
    state,
    findTabByTitle(title) {
      const tab = state.tabs.find((item) => item.title === title);
      return tab ? { sessionId: tab.sessionId } : undefined;
    },
    async createNewTab(request: BatchTabRequest) {
      const model = request.model
        ? findModelRef(state.availableModels, request.model)
        : state.model;
      assertModelEnabled(model);
      const thinkingLevel = (request.thinking as ThinkingLevel | undefined) ?? state.thinkingLevel;
      // createAgentTab treats a missing runtimeModel as "use the default", so an
      // unresolvable selection would silently start the batch tab on the wrong
      // model instead of failing the batch request.
      const runtimeModel = runtime.resolveModel(model.provider, model.modelId);
      if (!runtimeModel)
        throw new Error(`Model is not registered in runtime: ${model.provider}/${model.modelId}`);
      const tab = await createAgentTab(state, runtime, {
        title: request.name,
        workdir: request.workdir,
        model,
        runtimeModel,
        thinkingLevel,
        systemPrompt: request.systemPrompt,
        onQueued: onStateChanged ? () => tui.requestRender() : undefined,
      });
      // The UI title is in-memory only; persist the batch name for bootstrap restore.
      runtime.renameSession(tab.sessionId, request.name);
      if (onStateChanged) await persist();
      return tab.sessionId;
    },
    async configureTab(sessionId, config) {
      const tab = state.tabs.find((item) => item.sessionId === sessionId);
      if (!tab) throw new Error(`Cannot configure unknown tab: ${sessionId}`);
      await runBatchActionWithSave(
        async () => {
          if (config.model) await applyModelSelection(state, tab, config.model, runtime);
          if (config.thinking) applyThinkingLevel(state, tab, config.thinking, runtime);
          if (config.contextLimit !== undefined) {
            const runtimeTab = runtime.requireTab(sessionId);
            applyContextLimitToSession(tab, config.contextLimit, runtimeTab.agentSession);
          }
        },
        async () => {
          if (onStateChanged) await persist();
        },
      );
    },
    async clearTab(sessionId) {
      try {
        resetAgentTab(state, runtime, sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.startsWith("Error:") ? message : `Error: ${message}`, {
          cause: error,
        });
      }
      await persist();
    },
    async deleteTab(sessionId) {
      await deleteAgentTab(state, runtime, sessionId);
      await persist();
    },
    async submitInput(sessionId, input) {
      const tab = state.tabs.find((item) => item.sessionId === sessionId);
      if (!tab) throw new Error(`Cannot submit to unknown tab: ${sessionId}`);
      const parsed = parseInput(input);
      await runBatchActionWithSave(
        async () => {
          if (parsed.kind === "local-command") {
            throw new Error(
              `Batch prompt cannot execute MixCode local command: /${parsed.command}`,
            );
          }
          await submitAgentInput(tab, runtime, input, parsed);
        },
        async () => {
          if (onStateChanged) await persist();
        },
      );
    },
    resolveModel(query) {
      const model = findModelRef(state.availableModels, query);
      assertModelEnabled(model);
      return model;
    },
  };
}

/** Always attempt the save; retain both errors when execution and saving fail. */
export async function runBatchActionWithSave(
  action: () => Promise<void>,
  save: () => Promise<void>,
): Promise<void> {
  const outcome = await Promise.resolve()
    .then(action)
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    await save();
  } catch (saveError) {
    if (!outcome.ok) {
      const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new AggregateError(
        [outcome.error, saveError],
        `${describe(outcome.error)}; failed to save batch state: ${describe(saveError)}`,
        { cause: outcome.error },
      );
    }
    throw saveError;
  }
  if (!outcome.ok) throw outcome.error;
}
