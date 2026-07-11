import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { BatchExecutorHost, BatchTabRequest } from "../core/batch-lua.js";
import { parseInput } from "../core/commands.js";
import { findModelRef } from "../core/models.js";
import type { MixCodeState } from "../core/types.js";
import { applyModelSelection, applyThinkingLevel } from "../ui/app-actions.js";
import type { OverlayTui } from "../ui/app-types.js";
import {
  completeAgentTabClear,
  createAgentTab,
  deleteAgentTab,
  prepareAgentTabClear,
  submitAgentInput,
} from "../ui/agent-tab-actions.js";

/**
 * Adapt Lua batch requests to the same Agent tab actions used by the TUI. This
 * module resolves batch-only inputs such as title/model overrides; lifecycle,
 * clear invariants, deletion ordering, and prompt dispatch stay shared.
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
      const thinkingLevel = (request.thinking as ThinkingLevel | undefined) ?? state.thinkingLevel;
      const tab = await createAgentTab(state, runtime, {
        title: request.name,
        workdir: request.workdir,
        model,
        runtimeModel: runtime.resolveModel(model.provider, model.modelId),
        thinkingLevel,
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
    },
    async clearTab(sessionId) {
      const prepared = prepareAgentTabClear(state, runtime, sessionId);
      // Publish the immediate empty state before replacement starts, matching the
      // interactive adapter's two-phase clear without introducing a fake delay.
      tui.requestRender();
      const nextSessionId = await completeAgentTabClear(state, runtime, prepared);
      tui.requestRender();
      return nextSessionId;
    },
    async deleteTab(sessionId) {
      await deleteAgentTab(state, runtime, sessionId);
      tui.requestRender();
    },
    async submitInput(sessionId, input) {
      const tab = state.tabs.find((item) => item.sessionId === sessionId);
      if (!tab) throw new Error(`Cannot submit to unknown tab: ${sessionId}`);
      const parsed = parseInput(input);
      if (await submitAgentInput(tab, runtime, input, parsed)) return;
      const command = parsed.command ? `/${parsed.command}` : input;
      throw new Error(`Batch prompt cannot execute MixCode local command: ${command}`);
    },
    resolveModel(query) {
      return findModelRef(state.availableModels, query);
    },
  };
}
