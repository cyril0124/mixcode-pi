import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { fuzzyMatch, fuzzyMatchPositions, substringMatchPositions } from "./fuzzy.js";

// --- Types ---

export type SessionSelectorScope = "current" | "all";
export type SessionSortMode = "threaded" | "recent" | "relevance";
export type SessionNameFilter = "all" | "named";

export interface SessionSelectorState {
  open: boolean;
  scope: SessionSelectorScope;
  sortMode: SessionSortMode;
  nameFilter: SessionNameFilter;
  query: string;
  selectedIndex: number;
  showPath: boolean;
  /** Sessions for the current-folder scope */
  currentSessions: SessionInfo[];
  /** Sessions for the all scope */
  allSessions: SessionInfo[];
  /** Whether the all-scope sessions have been loaded */
  allLoaded: boolean;
  /** Loading state */
  loading: boolean;
  /** Status message (e.g. after delete) */
  statusMessage: string;
  statusType: "info" | "error";
  /** Path of session pending delete confirmation */
  confirmingDeletePath: string | null;
  /** Current session file path (to prevent deleting active session) */
  currentSessionPath: string | null;
  /** Rename mode */
  renameMode: boolean;
  renameTargetPath: string | null;
  renameInput: string;
}

export function createSessionSelectorState(): SessionSelectorState {
  return {
    open: false,
    scope: "current",
    sortMode: "threaded",
    nameFilter: "all",
    query: "",
    selectedIndex: 0,
    showPath: false,
    currentSessions: [],
    allSessions: [],
    allLoaded: false,
    loading: false,
    statusMessage: "",
    statusType: "info",
    confirmingDeletePath: null,
    currentSessionPath: null,
    renameMode: false,
    renameTargetPath: null,
    renameInput: "",
  };
}

// --- Tree building ---

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

export interface FlatSessionNode {
  session: SessionInfo;
  depth: number;
  isLast: boolean;
  ancestorContinues: boolean[];
}

function canonicalizePath(path: string | undefined): string | undefined {
  return path?.replace(/\/+$/, "");
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byPath = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    const key = canonicalizePath(session.path) ?? session.path;
    byPath.set(key, { session, children: [] });
  }
  const roots: SessionTreeNode[] = [];
  for (const session of sessions) {
    const key = canonicalizePath(session.path) ?? session.path;
    const node = byPath.get(key)!;
    const parentPath = canonicalizePath(session.parentSessionPath);
    if (parentPath && byPath.has(parentPath)) {
      byPath.get(parentPath)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: SessionTreeNode[]): void => {
    nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
  const result: FlatSessionNode[] = [];
  const walk = (
    node: SessionTreeNode,
    depth: number,
    ancestorContinues: boolean[],
    isLast: boolean,
  ): void => {
    result.push({ session: node.session, depth, isLast, ancestorContinues });
    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      const continues = depth > 0 ? !isLast : false;
      walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
    }
  };
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i]!, 0, [], i === roots.length - 1);
  }
  return result;
}

// --- Search / filter ---

function hasSessionName(session: SessionInfo): boolean {
  return Boolean(session.name?.trim());
}

function getSessionSearchText(session: SessionInfo): string {
  return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

interface ParsedSearchQuery {
  mode: "tokens" | "regex";
  tokens: { kind: "fuzzy" | "phrase"; value: string }[];
  regex: RegExp | null;
  error?: string;
}

function parseSearchQuery(query: string): ParsedSearchQuery {
  const trimmed = query.trim();
  if (!trimmed) return { mode: "tokens", tokens: [], regex: null };
  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (err) {
      return { mode: "regex", tokens: [], regex: null, error: String(err) };
    }
  }
  const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
  let buf = "";
  let inQuote = false;
  let hadUnclosedQuote = false;
  const flush = (kind: "fuzzy" | "phrase"): void => {
    const v = buf.trim();
    buf = "";
    if (!v) return;
    tokens.push({ kind, value: v });
  };
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      flush("fuzzy");
      continue;
    }
    buf += ch;
  }
  if (inQuote) hadUnclosedQuote = true;
  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => ({ kind: "fuzzy" as const, value: t })),
      regex: null,
    };
  }
  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

function matchSession(
  session: SessionInfo,
  parsed: ParsedSearchQuery,
): { matches: boolean; score: number } {
  const text = getSessionSearchText(session);
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const idx = text.search(parsed.regex);
    if (idx < 0) return { matches: false, score: 0 };
    return { matches: true, score: idx * 0.1 };
  }
  if (parsed.tokens.length === 0) return { matches: true, score: 0 };
  let totalScore = 0;
  let normalizedText: string | null = null;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalizedText === null) {
        normalizedText = text.toLowerCase().replace(/\s+/g, " ").trim();
      }
      const phrase = token.value.toLowerCase().replace(/\s+/g, " ").trim();
      if (!phrase) continue;
      const idx = normalizedText.indexOf(phrase);
      if (idx < 0) return { matches: false, score: 0 };
      totalScore += idx * 0.1;
      continue;
    }
    const m = fuzzyMatch(token.value, text);
    if (m === undefined) return { matches: false, score: 0 };
    totalScore += m;
  }
  return { matches: true, score: totalScore };
}

// --- Public API ---

/**
 * Get the filtered and sorted flat session nodes for display.
 */
export function getFilteredSessions(state: SessionSelectorState): FlatSessionNode[] {
  const sessions = state.scope === "all" ? state.allSessions : state.currentSessions;
  const nameFiltered =
    state.nameFilter === "all" ? sessions : sessions.filter((s) => hasSessionName(s));
  const trimmed = state.query.trim();

  if (state.sortMode === "threaded" && !trimmed) {
    // Tree structure without search
    const roots = buildSessionTree(nameFiltered);
    return flattenSessionTree(roots);
  }

  // Flat list with search
  if (!trimmed) {
    const flatSessions =
      state.sortMode === "recent" ? [...nameFiltered].sort(compareSessionModifiedDesc) : nameFiltered;
    return flatSessions.map((session) => ({
      session,
      depth: 0,
      isLast: true,
      ancestorContinues: [],
    }));
  }

  const parsed = parseSearchQuery(trimmed);
  if (parsed.error) return [];

  if (state.sortMode === "recent") {
    return nameFiltered
      .filter((s) => matchSession(s, parsed).matches)
      .sort(compareSessionModifiedDesc)
      .map((session) => ({ session, depth: 0, isLast: true, ancestorContinues: [] }));
  }

  // Relevance sort
  const scored: { session: SessionInfo; score: number }[] = [];
  for (const s of nameFiltered) {
    const res = matchSession(s, parsed);
    if (res.matches) scored.push({ session: s, score: res.score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.session.modified.getTime() - a.session.modified.getTime();
  });
  return scored.map((r) => ({
    session: r.session,
    depth: 0,
    isLast: true,
    ancestorContinues: [],
  }));
}

function compareSessionModifiedDesc(left: SessionInfo, right: SessionInfo): number {
  return right.modified.getTime() - left.modified.getTime();
}

/**
 * Match positions within the *displayed* row text (session name or first
 * message), for highlighting. Independent of matchSession's full search blob
 * (id + name + allMessagesText + cwd): a session can match via a field that
 * isn't shown in this row (e.g. a buried chat message), in which case this
 * simply returns no positions — the row still appears because
 * getFilteredSessions already decided inclusion via matchSession.
 *
 * ponytail: phrase tokens are matched against the raw display text rather
 * than the whitespace-collapsed text matchSession searches; a phrase with
 * unusual internal spacing may not highlight. Add normalization if reported.
 */
export function sessionDisplayHighlightPositions(query: string, displayText: string): number[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const parsed = parseSearchQuery(trimmed);
  if (parsed.mode === "regex") {
    if (!parsed.regex) return [];
    const match = displayText.match(parsed.regex);
    if (!match || match.index === undefined || match[0].length === 0) return [];
    return Array.from({ length: match[0].length }, (_, i) => match.index! + i);
  }
  const positions = new Set<number>();
  for (const token of parsed.tokens) {
    const tokenPositions =
      token.kind === "phrase"
        ? substringMatchPositions(token.value, displayText)
        : fuzzyMatchPositions(token.value, displayText);
    for (const pos of tokenPositions) positions.add(pos);
  }
  return [...positions].sort((a, b) => a - b);
}

export function toggleSessionSelectorScope(state: SessionSelectorState): void {
  state.scope = state.scope === "current" ? "all" : "current";
  state.selectedIndex = 0;
}

export function cycleSessionSortMode(state: SessionSelectorState): void {
  state.sortMode =
    state.sortMode === "threaded"
      ? "recent"
      : state.sortMode === "recent"
        ? "relevance"
        : "threaded";
  state.selectedIndex = 0;
}

export function toggleSessionNameFilter(state: SessionSelectorState): void {
  state.nameFilter = state.nameFilter === "all" ? "named" : "all";
  state.selectedIndex = 0;
}

export function moveSessionSelectorSelection(state: SessionSelectorState, delta: number): void {
  const count = getFilteredSessions(state).length;
  if (count === 0) {
    state.selectedIndex = 0;
    return;
  }
  state.selectedIndex = Math.max(0, Math.min(count - 1, state.selectedIndex + delta));
}

export function getSelectedSessionPath(state: SessionSelectorState): string | undefined {
  const nodes = getFilteredSessions(state);
  return nodes[state.selectedIndex]?.session.path;
}

export function updateSessionSelectorQuery(state: SessionSelectorState, query: string): void {
  state.query = query;
  const count = getFilteredSessions(state).length;
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, count - 1));
}

export function formatSessionDate(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}
