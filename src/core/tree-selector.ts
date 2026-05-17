import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { getSearchableText, hasTextContent, type ToolCallInfo } from "./tree-content.js";

export { extractContent, formatToolCall } from "./tree-content.js";
export type { ToolCallInfo } from "./tree-content.js";

/** Tree node type derived from SessionManager.getTree() */
export type SessionTreeNode = ReturnType<SessionManager["getTree"]>[number];

/** Filter mode for tree display */
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/** Flattened tree node for navigation */
export interface FlatTreeNode {
  node: SessionTreeNode;
  /** Indentation level (each level = 3 chars) */
  indent: number;
  /** Whether to show connector (├─ or └─) */
  showConnector: boolean;
  /** If showConnector, true = last sibling (└─), false = not last (├─) */
  isLast: boolean;
  /** Gutter info for each ancestor branch point */
  gutters: GutterInfo[];
  /** True if this node is a root under a virtual branching root (multiple roots) */
  isVirtualRootChild: boolean;
}

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
export interface GutterInfo {
  position: number;
  show: boolean;
}

/** Summarize prompt options */
export type SummarizeChoice = "no-summary" | "summarize" | "summarize-custom";

export interface SummarizePromptState {
  targetEntryId: string;
  selectedIndex: number;
  /** If in custom instructions input mode */
  customMode: boolean;
  customInput: string;
}

/** Tool call info for lookup */
export interface TreeSelectorState {
  open: boolean;
  flatNodes: FlatTreeNode[];
  filteredNodes: FlatTreeNode[];
  selectedIndex: number;
  currentLeafId: string | null;
  filterMode: TreeFilterMode;
  searchQuery: string;
  multipleRoots: boolean;
  activePathIds: Set<string>;
  visibleParentMap: Map<string, string | null>;
  visibleChildrenMap: Map<string | null, string[]>;
  foldedNodes: Set<string>;
  showLabelTimestamps: boolean;
  lastSelectedId: string | null;
  toolCallMap: Map<string, ToolCallInfo>;
  /** Label editing state */
  labelEditEntryId: string | null;
  labelEditInput: string;
  /** Summarize prompt state */
  summarizePrompt: SummarizePromptState | null;
}

export function createTreeSelectorState(): TreeSelectorState {
  return {
    open: false,
    flatNodes: [],
    filteredNodes: [],
    selectedIndex: 0,
    currentLeafId: null,
    filterMode: "default",
    searchQuery: "",
    multipleRoots: false,
    activePathIds: new Set(),
    visibleParentMap: new Map(),
    visibleChildrenMap: new Map(),
    foldedNodes: new Set(),
    showLabelTimestamps: false,
    lastSelectedId: null,
    toolCallMap: new Map(),
    labelEditEntryId: null,
    labelEditInput: "",
    summarizePrompt: null,
  };
}

/**
 * Initialize tree selector with session tree data.
 */
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
  state.searchQuery = "";
  state.foldedNodes.clear();
  state.showLabelTimestamps = false;
  state.labelEditEntryId = null;
  state.labelEditInput = "";
  state.multipleRoots = tree.length > 1;
  state.flatNodes = flattenTree(tree, currentLeafId, state.toolCallMap);
  state.multipleRoots = tree.length > 1;
  buildActivePath(state);
  applyTreeFilter(state);

  // Start with initialSelectedId if provided, otherwise current leaf
  const targetId = initialSelectedId ?? currentLeafId;
  state.selectedIndex = findNearestVisibleIndex(state, targetId);
  state.lastSelectedId = state.filteredNodes[state.selectedIndex]?.node.entry.id ?? null;
}

// --- Tree flattening ---

export function flattenTree(
  roots: SessionTreeNode[],
  currentLeafId: string | null,
  toolCallMap: Map<string, ToolCallInfo>,
): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  toolCallMap.clear();

  type StackItem = [
    SessionTreeNode,
    number,
    boolean,
    boolean,
    boolean,
    GutterInfo[],
    boolean,
  ];
  const stack: StackItem[] = [];

  // Determine which subtrees contain the active leaf
  const containsActive = new Map<SessionTreeNode, boolean>();
  const leafId = currentLeafId;
  {
    const allNodes: SessionTreeNode[] = [];
    const preOrderStack: SessionTreeNode[] = [...roots];
    while (preOrderStack.length > 0) {
      const node = preOrderStack.pop()!;
      allNodes.push(node);
      for (let i = node.children.length - 1; i >= 0; i--) {
        preOrderStack.push(node.children[i]);
      }
    }
    for (let i = allNodes.length - 1; i >= 0; i--) {
      const node = allNodes[i];
      let has = leafId !== null && node.entry.id === leafId;
      for (const child of node.children) {
        if (containsActive.get(child)) has = true;
      }
      containsActive.set(node, has);
    }
  }

  // Add roots in reverse order, prioritizing the one containing the active leaf
  const multipleRoots = roots.length > 1;
  const orderedRoots = [...roots].sort(
    (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
  );
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    const isLast = i === orderedRoots.length - 1;
    stack.push([
      orderedRoots[i],
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      isLast,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;

    // Extract tool calls from assistant messages for later lookup
    const entry = node.entry;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const content = (entry.message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "toolCall"
          ) {
            const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
            toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
          }
        }
      }
    }

    result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

    const children = node.children;
    const multipleChildren = children.length > 1;

    // Order children so the branch containing the active leaf comes first
    const orderedChildren = (() => {
      const prioritized: SessionTreeNode[] = [];
      const rest: SessionTreeNode[] = [];
      for (const child of children) {
        if (containsActive.get(child)) {
          prioritized.push(child);
        } else {
          rest.push(child);
        }
      }
      return [...prioritized, ...rest];
    })();

    // Calculate child indent
    let childIndent: number;
    if (multipleChildren) {
      childIndent = indent + 1;
    } else if (justBranched && indent > 0) {
      childIndent = indent + 1;
    } else {
      childIndent = indent;
    }

    // Build gutters for children
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters: GutterInfo[] = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    // Add children in reverse order
    for (let i = orderedChildren.length - 1; i >= 0; i--) {
      const childIsLast = i === orderedChildren.length - 1;
      stack.push([
        orderedChildren[i],
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }

  return result;
}

// --- Active path ---

function buildActivePath(state: TreeSelectorState): void {
  state.activePathIds.clear();
  if (!state.currentLeafId) return;

  const entryMap = new Map<string, FlatTreeNode>();
  for (const flatNode of state.flatNodes) {
    entryMap.set(flatNode.node.entry.id, flatNode);
  }

  let currentId: string | null = state.currentLeafId;
  while (currentId) {
    state.activePathIds.add(currentId);
    const node = entryMap.get(currentId);
    if (!node) break;
    currentId = node.node.entry.parentId ?? null;
  }
}

// --- Filtering ---

export function applyTreeFilter(state: TreeSelectorState): void {
  // Preserve last selected ID
  if (state.filteredNodes.length > 0) {
    state.lastSelectedId =
      state.filteredNodes[state.selectedIndex]?.node.entry.id ?? state.lastSelectedId;
  }

  const searchTokens = state.searchQuery
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  state.filteredNodes = state.flatNodes.filter((flatNode) => {
    const entry = flatNode.node.entry;
    const isCurrentLeaf = entry.id === state.currentLeafId;

    // Skip assistant messages with only tool calls (no text) unless error/aborted
    if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
      const msg = entry.message as { stopReason?: string; content?: unknown };
      const hasText = hasTextContent(msg.content);
      const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
      if (!hasText && !isErrorOrAborted) return false;
    }

    // Apply filter mode
    let passesFilter = true;
    const isSettingsEntry =
      entry.type === "label" ||
      entry.type === "custom" ||
      entry.type === "model_change" ||
      entry.type === "thinking_level_change" ||
      entry.type === "session_info";

    switch (state.filterMode) {
      case "user-only":
        passesFilter = entry.type === "message" && entry.message.role === "user";
        break;
      case "no-tools":
        passesFilter =
          !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
        break;
      case "labeled-only":
        passesFilter = flatNode.node.label !== undefined;
        break;
      case "all":
        passesFilter = true;
        break;
      default:
        passesFilter = !isSettingsEntry;
        break;
    }

    if (!passesFilter) return false;

    // Apply search filter
    if (searchTokens.length > 0) {
      const nodeText = getSearchableText(flatNode.node, state.toolCallMap).toLowerCase();
      return searchTokens.every((token) => nodeText.includes(token));
    }

    return true;
  });

  // Filter out descendants of folded nodes
  if (state.foldedNodes.size > 0) {
    const skipSet = new Set<string>();
    for (const flatNode of state.flatNodes) {
      const { id, parentId } = flatNode.node.entry;
      if (parentId != null && (state.foldedNodes.has(parentId) || skipSet.has(parentId))) {
        skipSet.add(id);
      }
    }
    state.filteredNodes = state.filteredNodes.filter(
      (flatNode) => !skipSet.has(flatNode.node.entry.id),
    );
  }

  // Recalculate visual structure
  recalculateVisualStructure(state);

  // Preserve cursor position
  if (state.lastSelectedId) {
    state.selectedIndex = findNearestVisibleIndex(state, state.lastSelectedId);
  } else if (state.selectedIndex >= state.filteredNodes.length) {
    state.selectedIndex = Math.max(0, state.filteredNodes.length - 1);
  }

  if (state.filteredNodes.length > 0) {
    state.lastSelectedId =
      state.filteredNodes[state.selectedIndex]?.node.entry.id ?? state.lastSelectedId;
  }
}

// --- Visual structure recalculation ---

function recalculateVisualStructure(state: TreeSelectorState): void {
  if (state.filteredNodes.length === 0) return;

  const visibleIds = new Set(state.filteredNodes.map((n) => n.node.entry.id));

  const entryMap = new Map<string, FlatTreeNode>();
  for (const flatNode of state.flatNodes) {
    entryMap.set(flatNode.node.entry.id, flatNode);
  }

  const findVisibleAncestor = (nodeId: string): string | null => {
    let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
    while (currentId !== null) {
      if (visibleIds.has(currentId)) return currentId;
      currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
    }
    return null;
  };

  const visibleParent = new Map<string, string | null>();
  const visibleChildren = new Map<string | null, string[]>();
  visibleChildren.set(null, []);

  for (const flatNode of state.filteredNodes) {
    const nodeId = flatNode.node.entry.id;
    const ancestorId = findVisibleAncestor(nodeId);
    visibleParent.set(nodeId, ancestorId);
    if (!visibleChildren.has(ancestorId)) visibleChildren.set(ancestorId, []);
    visibleChildren.get(ancestorId)!.push(nodeId);
  }

  const visibleRootIds = visibleChildren.get(null)!;
  state.multipleRoots = visibleRootIds.length > 1;

  const filteredNodeMap = new Map<string, FlatTreeNode>();
  for (const flatNode of state.filteredNodes) {
    filteredNodeMap.set(flatNode.node.entry.id, flatNode);
  }

  // DFS over the visible tree
  type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
  const stack: StackItem[] = [];

  for (let i = visibleRootIds.length - 1; i >= 0; i--) {
    const isLast = i === visibleRootIds.length - 1;
    stack.push([
      visibleRootIds[i],
      state.multipleRoots ? 1 : 0,
      state.multipleRoots,
      state.multipleRoots,
      isLast,
      [],
      state.multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;

    const flatNode = filteredNodeMap.get(nodeId);
    if (!flatNode) continue;

    flatNode.indent = indent;
    flatNode.showConnector = showConnector;
    flatNode.isLast = isLast;
    flatNode.gutters = gutters;
    flatNode.isVirtualRootChild = isVirtualRootChild;

    const children = visibleChildren.get(nodeId) || [];
    const multipleChildren = children.length > 1;

    let childIndent: number;
    if (multipleChildren) {
      childIndent = indent + 1;
    } else if (justBranched && indent > 0) {
      childIndent = indent + 1;
    } else {
      childIndent = indent;
    }

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = state.multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters: GutterInfo[] = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    for (let i = children.length - 1; i >= 0; i--) {
      const childIsLast = i === children.length - 1;
      stack.push([children[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
    }
  }

  state.visibleParentMap = visibleParent;
  state.visibleChildrenMap = visibleChildren;
}

// --- Navigation helpers ---

export function findNearestVisibleIndex(
  state: TreeSelectorState,
  entryId: string | null,
): number {
  if (state.filteredNodes.length === 0) return 0;

  const entryMap = new Map<string, FlatTreeNode>();
  for (const flatNode of state.flatNodes) {
    entryMap.set(flatNode.node.entry.id, flatNode);
  }

  const visibleIdToIndex = new Map<string, number>(
    state.filteredNodes.map((node, i) => [node.node.entry.id, i]),
  );

  let currentId = entryId;
  while (currentId !== null) {
    const index = visibleIdToIndex.get(currentId);
    if (index !== undefined) return index;
    const node = entryMap.get(currentId);
    if (!node) break;
    currentId = node.node.entry.parentId ?? null;
  }

  return state.filteredNodes.length - 1;
}

export function moveTreeSelection(state: TreeSelectorState, direction: -1 | 1): void {
  if (state.filteredNodes.length === 0) return;
  if (direction === -1) {
    state.selectedIndex =
      state.selectedIndex === 0 ? state.filteredNodes.length - 1 : state.selectedIndex - 1;
  } else {
    state.selectedIndex =
      state.selectedIndex === state.filteredNodes.length - 1 ? 0 : state.selectedIndex + 1;
  }
}

export function pageTreeSelection(state: TreeSelectorState, direction: -1 | 1, pageSize: number): void {
  if (state.filteredNodes.length === 0) return;
  if (direction === -1) {
    state.selectedIndex = Math.max(0, state.selectedIndex - pageSize);
  } else {
    state.selectedIndex = Math.min(state.filteredNodes.length - 1, state.selectedIndex + pageSize);
  }
}

export function cycleTreeFilter(state: TreeSelectorState, direction: 1 | -1): void {
  const modes: TreeFilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
  const currentIndex = modes.indexOf(state.filterMode);
  state.filterMode = modes[(currentIndex + direction + modes.length) % modes.length];
  state.foldedNodes.clear();
  applyTreeFilter(state);
}

export function setTreeFilter(state: TreeSelectorState, mode: TreeFilterMode): void {
  state.filterMode = mode;
  state.foldedNodes.clear();
  applyTreeFilter(state);
}

export function updateTreeSearchQuery(state: TreeSelectorState, query: string): void {
  state.searchQuery = query;
  state.foldedNodes.clear();
  applyTreeFilter(state);
}

export function getSelectedTreeEntry(state: TreeSelectorState): SessionEntry | undefined {
  return state.filteredNodes[state.selectedIndex]?.node.entry;
}

export function getSelectedTreeNode(state: TreeSelectorState): SessionTreeNode | undefined {
  return state.filteredNodes[state.selectedIndex]?.node;
}

/**
 * Whether a node can be folded. A node is foldable if it has visible children
 * and is either a root or a segment start (visible parent has multiple visible children).
 */
export function isFoldable(state: TreeSelectorState, entryId: string): boolean {
  const children = state.visibleChildrenMap.get(entryId);
  if (!children || children.length === 0) return false;
  const parentId = state.visibleParentMap.get(entryId);
  if (parentId === null || parentId === undefined) return true;
  const siblings = state.visibleChildrenMap.get(parentId);
  return siblings !== undefined && siblings.length > 1;
}

export function toggleFold(state: TreeSelectorState, entryId: string): void {
  if (state.foldedNodes.has(entryId)) {
    state.foldedNodes.delete(entryId);
  } else if (isFoldable(state, entryId)) {
    state.foldedNodes.add(entryId);
  }
  applyTreeFilter(state);
}

export function foldOrUp(state: TreeSelectorState): void {
  const currentId = state.filteredNodes[state.selectedIndex]?.node.entry.id;
  if (currentId && isFoldable(state, currentId) && !state.foldedNodes.has(currentId)) {
    state.foldedNodes.add(currentId);
    applyTreeFilter(state);
  } else {
    state.selectedIndex = findBranchSegmentStart(state, "up");
  }
}

export function unfoldOrDown(state: TreeSelectorState): void {
  const currentId = state.filteredNodes[state.selectedIndex]?.node.entry.id;
  if (currentId && state.foldedNodes.has(currentId)) {
    state.foldedNodes.delete(currentId);
    applyTreeFilter(state);
  } else {
    state.selectedIndex = findBranchSegmentStart(state, "down");
  }
}

function findBranchSegmentStart(state: TreeSelectorState, direction: "up" | "down"): number {
  const selectedId = state.filteredNodes[state.selectedIndex]?.node.entry.id;
  if (!selectedId) return state.selectedIndex;

  const indexByEntryId = new Map(
    state.filteredNodes.map((node, i) => [node.node.entry.id, i]),
  );

  let currentId: string = selectedId;
  if (direction === "down") {
    while (true) {
      const children: string[] = state.visibleChildrenMap.get(currentId) ?? [];
      if (children.length === 0) return indexByEntryId.get(currentId)!;
      if (children.length > 1) return indexByEntryId.get(children[0])!;
      currentId = children[0];
    }
  }

  // direction === "up"
  while (true) {
    const parentId: string | null = state.visibleParentMap.get(currentId) ?? null;
    if (parentId === null) return indexByEntryId.get(currentId)!;
    const children = state.visibleChildrenMap.get(parentId) ?? [];
    if (children.length > 1) {
      const segmentStart = indexByEntryId.get(currentId)!;
      if (segmentStart < state.selectedIndex) return segmentStart;
    }
    currentId = parentId;
  }
}

export {
  cancelCustomInstructions,
  cancelSummarizePrompt,
  confirmCustomInstructions,
  confirmSummarizeSelection,
  moveSummarizeSelection,
  showSummarizePrompt,
  SUMMARIZE_OPTIONS,
} from "./tree-summarize.js";

// --- Label editing ---

export function startLabelEdit(state: TreeSelectorState): void {
  const node = state.filteredNodes[state.selectedIndex]?.node;
  if (!node) return;
  state.labelEditEntryId = node.entry.id;
  state.labelEditInput = node.label ?? "";
}

export function cancelLabelEdit(state: TreeSelectorState): void {
  state.labelEditEntryId = null;
  state.labelEditInput = "";
}

export function confirmLabelEdit(state: TreeSelectorState): { entryId: string; label: string | undefined } | null {
  if (!state.labelEditEntryId) return null;
  const entryId = state.labelEditEntryId;
  const label = state.labelEditInput.trim() || undefined;

  // Update the node's label in the flat tree
  for (const flatNode of state.flatNodes) {
    if (flatNode.node.entry.id === entryId) {
      flatNode.node.label = label;
      flatNode.node.labelTimestamp = label ? new Date().toISOString() : undefined;
      break;
    }
  }

  state.labelEditEntryId = null;
  state.labelEditInput = "";
  return { entryId, label };
}
