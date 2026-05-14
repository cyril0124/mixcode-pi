import type { TreeSelectorState } from "./tree-selector.js";

export const SUMMARIZE_OPTIONS = [
  "No summary",
  "Summarize",
  "Summarize with custom prompt",
] as const;

export function showSummarizePrompt(state: TreeSelectorState, targetEntryId: string): void {
  state.summarizePrompt = {
    targetEntryId,
    selectedIndex: 0,
    customMode: false,
    customInput: "",
  };
}

export function cancelSummarizePrompt(state: TreeSelectorState): void {
  state.summarizePrompt = null;
}

export function moveSummarizeSelection(state: TreeSelectorState, direction: -1 | 1): void {
  if (!state.summarizePrompt) return;
  const count = SUMMARIZE_OPTIONS.length;
  state.summarizePrompt.selectedIndex =
    (state.summarizePrompt.selectedIndex + direction + count) % count;
}

export function confirmSummarizeSelection(
  state: TreeSelectorState,
): { targetEntryId: string; summarize: boolean; customInstructions?: string } | null {
  if (!state.summarizePrompt) return null;
  const { targetEntryId, selectedIndex } = state.summarizePrompt;
  const choice = SUMMARIZE_OPTIONS[selectedIndex];

  if (choice === "Summarize with custom prompt") {
    state.summarizePrompt.customMode = true;
    return null;
  }

  state.summarizePrompt = null;
  return {
    targetEntryId,
    summarize: choice === "Summarize",
  };
}

export function confirmCustomInstructions(
  state: TreeSelectorState,
): { targetEntryId: string; summarize: boolean; customInstructions: string } | null {
  if (!state.summarizePrompt) return null;
  const { targetEntryId, customInput } = state.summarizePrompt;
  state.summarizePrompt = null;
  return {
    targetEntryId,
    summarize: true,
    customInstructions: customInput,
  };
}

export function cancelCustomInstructions(state: TreeSelectorState): void {
  if (!state.summarizePrompt) return;
  state.summarizePrompt.customMode = false;
  state.summarizePrompt.customInput = "";
}
