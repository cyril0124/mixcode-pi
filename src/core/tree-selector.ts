import {
  initTheme,
  type SessionManager,
  TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";

export type SessionTreeNode = ReturnType<SessionManager["getTree"]>[number];
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
export type TreeSelectorMode = "tree" | "navigate";

export interface SummarizePromptState {
  targetEntryId: string;
  selectedIndex: number;
  customMode: boolean;
  customInput: string;
}

export interface TreeSelectorState {
  open: boolean;
  ownerSessionId?: string;
  mode: TreeSelectorMode;
  tree: SessionTreeNode[];
  displayTree: SessionTreeNode[];
  currentLeafId: string | null;
  initialSelectedId?: string;
  filterMode: TreeFilterMode;
  allowedEntryIds: Set<string> | null;
  navigationEntryIds: string[];
  selectedEntryId: string | null;
  selectedIndex: number;
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
    mode: "tree",
    tree: [],
    displayTree: [],
    currentLeafId: null,
    initialSelectedId: undefined,
    filterMode: "default",
    allowedEntryIds: null,
    navigationEntryIds: [],
    selectedEntryId: null,
    selectedIndex: 0,
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
  mode: TreeSelectorMode = "tree",
  allowedEntryIds?: Set<string>,
): void {
  state.open = true;
  state.mode = mode;
  state.tree = tree;
  state.currentLeafId = currentLeafId;
  state.filterMode = initialFilterMode ?? "default";
  state.allowedEntryIds = allowedEntryIds ?? null;
  state.navigationEntryIds = [];
  state.displayTree =
    mode === "navigate"
      ? buildNavigationTree(tree, state.allowedEntryIds, state)
      : addToolSearchMetadata(tree);
  state.initialSelectedId =
    initialSelectedId ??
    (mode === "navigate" ? state.navigationEntryIds.at(-2) : (currentLeafId ?? undefined));
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
    state.mode === "navigate" ? null : state.currentLeafId,
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
    state.mode === "navigate" ? "all" : state.filterMode,
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
  if (state.mode === "navigate") {
    state.selectedIndex = Math.max(0, state.navigationEntryIds.indexOf(selected ?? ""));
  }
  state.initialSelectedId = selected ?? state.initialSelectedId;
  return selected;
}

export function updateTreeFilterState(state: TreeSelectorState, data: string): void {
  const modes: TreeFilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
  if (data === "\x04") state.filterMode = "default";
  else if (data === "\x0f") state.filterMode = nextMode(state.filterMode, modes, 1);
  else if (data === "\x14") {
    state.filterMode = state.filterMode === "no-tools" ? "default" : "no-tools";
  } else if (data === "\x15") {
    state.filterMode = state.filterMode === "user-only" ? "default" : "user-only";
  } else if (data === "\x0c") {
    state.filterMode = state.filterMode === "labeled-only" ? "default" : "labeled-only";
  } else if (data === "\x01") {
    state.filterMode = state.filterMode === "all" ? "default" : "all";
  }
}

function nextMode(
  current: TreeFilterMode,
  modes: TreeFilterMode[],
  direction: 1 | -1,
): TreeFilterMode {
  const index = modes.indexOf(current);
  return modes[(index + direction + modes.length) % modes.length]!;
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

  const cloneNode = (node: SessionTreeNode): SessionTreeNode => {
    let entry = node.entry;
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
    return { ...node, entry, children: node.children.map(cloneNode) };
  };
  return tree.map(cloneNode);
}

export const NEWEST_TREE_ENTRY_ID = "__mixcode_tree_newest__";

export function isNewestTreeSelection(state: TreeSelectorState): boolean {
  return state.mode === "navigate" && state.selectedEntryId === NEWEST_TREE_ENTRY_ID;
}

function buildNavigationTree(
  tree: SessionTreeNode[],
  allowedEntryIds: Set<string> | null,
  state: TreeSelectorState,
): SessionTreeNode[] {
  const nodes: SessionTreeNode[] = [];
  const stack = [...tree].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let index = node.children.length - 1; index >= 0; index--) {
      stack.push(node.children[index]!);
    }
    if (allowedEntryIds && !allowedEntryIds.has(node.entry.id)) continue;
    if (node.entry.type !== "message" || node.entry.message.role !== "user") continue;
    const sequence = state.navigationEntryIds.length + 1;
    state.navigationEntryIds.push(node.entry.id);
    nodes.push({
      ...node,
      entry: {
        ...node.entry,
        parentId: null,
        message: {
          ...node.entry.message,
          content: [
            {
              type: "text",
              text: `#${sequence} [${formatNavigationTimestamp(node.entry.timestamp)}] ${messageText(node)}`,
            },
          ],
        },
      },
      children: [],
    });
  }

  state.navigationEntryIds.push(NEWEST_TREE_ENTRY_ID);
  nodes.push({
    entry: {
      type: "message",
      id: NEWEST_TREE_ENTRY_ID,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "<NEWEST>" }],
        timestamp: 0,
      },
    },
    children: [],
  } as SessionTreeNode);
  return nodes;
}

function messageText(node: SessionTreeNode): string {
  if (node.entry.type !== "message" || !("content" in node.entry.message)) return "";
  const content = node.entry.message.content;
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatNavigationTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").slice(0, 16);
}
