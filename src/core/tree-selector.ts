import {
  initTheme,
  type SessionManager,
  TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";

export type SessionTreeNode = ReturnType<SessionManager["getTree"]>[number];
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface SummarizePromptState {
  targetEntryId: string;
  selectedIndex: number;
  customMode: boolean;
  customInput: string;
}

export interface TreeSelectorState {
  open: boolean;
  ownerSessionId?: string;
  displayTree: SessionTreeNode[];
  currentLeafId: string | null;
  initialSelectedId?: string;
  filterMode: TreeFilterMode;
  selectedEntryId: string | null;
  component?: TreeSelectorComponent;
  selectRequest?: string;
  cancelRequested: boolean;
  labelChangeRequest?: { entryId: string; label: string | undefined };
  copyRequest?: string;
  summarizePrompt: SummarizePromptState | null;
}

export function createTreeSelectorState(): TreeSelectorState {
  return {
    open: false,
    ownerSessionId: undefined,
    displayTree: [],
    currentLeafId: null,
    initialSelectedId: undefined,
    filterMode: "default",
    selectedEntryId: null,
    component: undefined,
    selectRequest: undefined,
    cancelRequested: false,
    labelChangeRequest: undefined,
    copyRequest: undefined,
    summarizePrompt: null,
  };
}

export function initTreeSelector(
  state: TreeSelectorState,
  tree: SessionTreeNode[],
  currentLeafId: string | null,
  initialSelectedId?: string,
  initialFilterMode?: TreeFilterMode,
): void {
  state.open = true;
  state.currentLeafId = currentLeafId;
  state.filterMode = initialFilterMode ?? "default";
  state.displayTree = addToolSearchMetadata(tree);
  state.initialSelectedId = initialSelectedId ?? currentLeafId ?? undefined;
  state.summarizePrompt = null;
  resetTreeSelectorComponent(state, process.stdout.rows || 24);
}

export function resetTreeSelectorComponent(
  state: TreeSelectorState,
  terminalHeight: number,
): TreeSelectorComponent {
  // MixCode themes currently use Pi's dark SDK mode; initialize only when the component is needed.
  initTheme("dark");
  state.selectRequest = undefined;
  state.cancelRequested = false;
  state.labelChangeRequest = undefined;
  state.copyRequest = undefined;
  const component = new TreeSelectorComponent(
    state.displayTree,
    state.currentLeafId,
    Math.max(1, terminalHeight),
    (entryId) => {
      state.selectRequest = entryId;
    },
    () => {
      state.cancelRequested = true;
    },
    (entryId, label) => {
      state.labelChangeRequest = { entryId, label };
    },
    state.initialSelectedId,
    state.filterMode,
  );
  component.onCopy = (text) => {
    if (text === undefined) return;
    const cleanText = text.replace(TOOL_SEARCH_METADATA_PATTERN, "");
    if (cleanText.trim()) state.copyRequest = cleanText;
  };
  state.component = component;
  syncTreeSelectorSelection(state);
  return component;
}

export function syncTreeSelectorSelection(state: TreeSelectorState): string | null {
  const selected = state.component?.getTreeList().getSelectedNode()?.entry.id ?? null;
  state.selectedEntryId = selected;
  state.initialSelectedId = selected ?? state.initialSelectedId;
  return selected;
}

const TOOL_SEARCH_METADATA_PREFIX = "\u0000mixcode-tree-tool:";
const TOOL_SEARCH_METADATA_PATTERN = /\u0000mixcode-tree-tool:[^\u0000]*\u0000/g;

function addToolSearchMetadata(tree: SessionTreeNode[]): SessionTreeNode[] {
  const toolNames = new Map<string, string>();
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stack.push(...node.children);
    if (node.entry.type !== "message" || node.entry.message.role !== "assistant") continue;
    const content = node.entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "toolCall") toolNames.set(block.id, block.name);
    }
  }

  const clonedRoots = tree.map((node) => ({ ...node, children: [] }) as SessionTreeNode);
  const cloneStack = tree.map((source, index) => ({ source, target: clonedRoots[index]! }));
  while (cloneStack.length > 0) {
    const { source, target } = cloneStack.pop()!;
    let entry = source.entry;
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const message = entry.message;
      const toolName = message.toolName ?? toolNames.get(message.toolCallId);
      if (toolName) {
        entry = {
          ...entry,
          message: {
            ...message,
            content: [
              { type: "text", text: `${TOOL_SEARCH_METADATA_PREFIX}${toolName}\u0000` },
              ...message.content,
            ],
          },
        };
      }
    }

    target.entry = entry;
    target.children = source.children.map(
      (child) => ({ ...child, children: [] }) as SessionTreeNode,
    );
    for (let index = 0; index < source.children.length; index++) {
      cloneStack.push({ source: source.children[index]!, target: target.children[index]! });
    }
  }
  return clonedRoots;
}

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
