import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { BatchExecutorHost, BatchTabRequest } from "../core/batch-lua.js";
import { parseInput } from "../core/commands.js";
import { applyContextLimitToSession } from "../core/context-limit.js";
import { assertModelEnabled, findModelRef } from "../core/models.js";
import type { MixCodeState } from "../core/types.js";
import {
  createAgentTab,
  deleteAgentTab,
  resetAgentTab,
  submitAgentInput,
} from "../ui/agent-tab-actions.js";
import { applyModelSelection, applyThinkingLevel } from "../ui/app-actions.js";
import type { OverlayTui } from "../ui/app-types.js";

/**
 * Adapt Lua batch requests to the same Agent tab actions used by the TUI. This
 * module resolves batch-only inputs such as title/model overrides; lifecycle,
 * reset invariants, deletion ordering, and prompt dispatch stay shared.
 */
export function createBatchExecutorHost(options: {
  state: MixCodeState;
  runtime: MixCodeRuntime;
  tui: Pick<OverlayTui, "requestRender">;
}): BatchExecutorHost {
  const { state, runtime, tui } = options;
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
      });
      // The UI title is in-memory only; persist the batch name for bootstrap restore.
      runtime.renameSession(tab.sessionId, request.name);
      return tab.sessionId;
    },
    async configureTab(sessionId, config) {
      const tab = state.tabs.find((item) => item.sessionId === sessionId);
      if (!tab) throw new Error(`Cannot configure unknown tab: ${sessionId}`);
      if (config.model) await applyModelSelection(state, tab, config.model, runtime);
      if (config.thinking) applyThinkingLevel(state, tab, config.thinking, runtime);
      if (config.contextLimit !== undefined) {
        // Model selection resets the window; apply the request's limit afterward.
        const runtimeTab = runtime.requireTab(sessionId);
        applyContextLimitToSession(tab, config.contextLimit, runtimeTab.agentSession);
      }
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
      tui.requestRender();
    },
    async deleteTab(sessionId) {
      await deleteAgentTab(state, runtime, sessionId);
      tui.requestRender();
    },
    async submitInput(sessionId, input) {
      const tab = state.tabs.find((item) => item.sessionId === sessionId);
      if (!tab) throw new Error(`Cannot submit to unknown tab: ${sessionId}`);
      const parsed = parseInput(input);
      if (parsed.kind === "local-command") {
        throw new Error(`Batch prompt cannot execute MixCode local command: /${parsed.command}`);
      }
      await submitAgentInput(tab, runtime, input, parsed);
    },
    resolveModel(query) {
      const model = findModelRef(state.availableModels, query);
      assertModelEnabled(model);
      return model;
    },
  };
}
