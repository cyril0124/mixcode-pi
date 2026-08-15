import {
  getKeybindings,
  matchesKey,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { discardVimTranscriptSearch } from "../core/tabs.js";
import type { MixCodeTabInfo, VimTranscriptSearchState } from "../core/types.js";
import type { MixCodeEditorActions, OverlayTui } from "./app-types.js";

export interface TranscriptSearchSegment {
  row: number;
  startCol: number;
  endCol: number;
}

export interface TranscriptSearchMatch {
  segments: TranscriptSearchSegment[];
}

interface SearchCorpus {
  text: string;
  source: Array<TranscriptSearchSegment | undefined>;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function appendMappedText(
  text: string,
  span: TranscriptSearchSegment | undefined,
  corpus: SearchCorpus,
): void {
  corpus.text += text;
  for (let index = 0; index < text.length; index++) corpus.source.push(span);
}

function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
  const corpus: SearchCorpus = { text: "", source: [] };
  let pendingSeparator = false;
  for (let row = 0; row < lines.length; row++) {
    const line = stripTerminalSequences(lines[row] ?? "");
    let column = 0;
    for (const item of graphemeSegmenter.segment(line)) {
      const text = item.segment;
      const width = visibleWidth(text);
      if (/^\s+$/u.test(text)) {
        if (corpus.text.length > 0) pendingSeparator = true;
        column += width;
        continue;
      }
      if (pendingSeparator) {
        appendMappedText(" ", undefined, corpus);
        pendingSeparator = false;
      }
      appendMappedText(text, { row, startCol: column, endCol: column + width }, corpus);
      column += width;
    }
    if (corpus.text.length > 0) pendingSeparator = true;
  }
  return corpus;
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTranscriptSearchMatches(
  lines: readonly string[],
  query: string,
): TranscriptSearchMatch[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return [];
  const corpus = buildSearchCorpus(lines);
  const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
  const matches: TranscriptSearchMatch[] = [];
  for (const match of corpus.text.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    const segments: TranscriptSearchSegment[] = [];
    for (let index = start; index < end; index++) {
      const span = corpus.source[index];
      if (!span) continue;
      const previous = segments.at(-1);
      if (previous && previous.row === span.row && span.startCol <= previous.endCol) {
        previous.endCol = Math.max(previous.endCol, span.endCol);
      } else {
        segments.push({ ...span });
      }
    }
    if (segments.length > 0) matches.push({ segments });
  }
  return matches;
}

export function transcriptSearchMatchKey(match: TranscriptSearchMatch): string {
  const first = match.segments[0];
  const last = match.segments.at(-1);
  return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export function isVimTranscriptSearchOpenKey(data: string): boolean {
  return data === "/";
}

export function openVimTranscriptSearch(
  tab: MixCodeTabInfo,
  editorActions: MixCodeEditorActions,
): boolean {
  if (!tab.vimMode || tab.vimTranscriptSearch?.promptOpen) return false;
  const previous = tab.vimTranscriptSearch;
  const editorText = editorActions.getExpandedText?.() ?? editorActions.getText();
  const cancelSnapshot = {
    query: previous?.query ?? "",
    selectedIndex: previous?.selectedIndex ?? -1,
    resultCount: previous?.resultCount ?? 0,
    selectedKey: previous?.selectedKey,
    chatScrollOffset: tab.chatScrollOffset,
    chatScrollAnchorEntryId: tab.chatScrollAnchorEntryId,
    chatScrollAnchorIndex: tab.chatScrollAnchorIndex,
    chatScrollAnchorText: tab.chatScrollAnchorText,
    editorText,
  };
  tab.vimTranscriptSearch = {
    query: "",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: tab.lastChatScrollMetrics?.start ?? 0,
    anchorPending: true,
    promptOpen: true,
    cancelSnapshot,
  };
  tab.chatScrollAnchorEntryId = undefined;
  tab.chatScrollAnchorIndex = undefined;
  tab.chatScrollAnchorText = undefined;
  editorActions.setText("");
  // The editor now contains the transient query, not the user's message draft.
  tab.draftInput = editorText;
  return true;
}

export function handleVimTranscriptSearchPromptKey(
  tab: MixCodeTabInfo,
  data: string,
  tui: Pick<OverlayTui, "requestRender">,
  editorActions: MixCodeEditorActions,
): boolean {
  const search = tab.vimTranscriptSearch;
  if (!tab.vimMode || !search?.promptOpen) return false;
  const keybindings = getKeybindings();
  if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
    navigateVimTranscriptSearch(tab, "previous", tui);
    return true;
  }
  if (keybindings.matches(data, "tui.altScreen.searchNext") && !matchesKey(data, "enter")) {
    navigateVimTranscriptSearch(tab, "next", tui);
    return true;
  }
  if (
    matchesKey(data, "up") ||
    matchesKey(data, "down") ||
    matchesKey(data, "tab") ||
    matchesKey(data, "shift+tab")
  ) {
    return true;
  }
  if (matchesKey(data, "escape")) {
    cancelVimTranscriptSearch(tab, editorActions);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "enter")) {
    commitVimTranscriptSearch(tab, editorActions);
    tui.requestRender();
    return true;
  }
  return false;
}

export function handleVimTranscriptSearchRepeat(
  tab: MixCodeTabInfo,
  data: string,
  tui: Pick<OverlayTui, "requestRender">,
): boolean {
  const search = tab.vimTranscriptSearch;
  if (!tab.vimMode || search?.promptOpen || !search?.query.trim()) return false;
  if (data !== "n" && data !== "N") return false;
  search.selectionMode = data === "n" ? "next" : "previous";
  tui.requestRender();
  return true;
}

export function clearVimTranscriptSearch(tab: MixCodeTabInfo): void {
  discardVimTranscriptSearch(tab);
}

function navigateVimTranscriptSearch(
  tab: MixCodeTabInfo,
  mode: "next" | "previous",
  tui: Pick<OverlayTui, "requestRender">,
): void {
  const search = tab.vimTranscriptSearch;
  if (!search?.query.trim()) return;
  search.selectionMode = mode;
  tui.requestRender();
}

function commitVimTranscriptSearch(tab: MixCodeTabInfo, editorActions: MixCodeEditorActions): void {
  const search = tab.vimTranscriptSearch;
  if (!search) return;
  const editorText = search.cancelSnapshot?.editorText ?? tab.draftInput;
  clearTransientSearchEditor(search, editorActions);
  search.promptOpen = false;
  search.cancelSnapshot = undefined;
  if (!search.query.trim()) tab.vimTranscriptSearch = undefined;
  restoreVimEditorDraft(tab, editorActions, editorText);
}

function cancelVimTranscriptSearch(tab: MixCodeTabInfo, editorActions: MixCodeEditorActions): void {
  const search = tab.vimTranscriptSearch;
  const snapshot = search?.cancelSnapshot;
  if (search) clearTransientSearchEditor(search, editorActions);
  if (snapshot) {
    tab.chatScrollOffset = snapshot.chatScrollOffset;
    tab.chatScrollAnchorEntryId = snapshot.chatScrollAnchorEntryId;
    tab.chatScrollAnchorIndex = snapshot.chatScrollAnchorIndex;
    tab.chatScrollAnchorText = snapshot.chatScrollAnchorText;
    tab.vimTranscriptSearch = snapshot.query
      ? {
          query: snapshot.query,
          selectedIndex: snapshot.selectedIndex,
          resultCount: snapshot.resultCount,
          selectedKey: snapshot.selectedKey,
          selectionMode: "retain",
          anchorRow: tab.lastChatScrollMetrics?.start ?? 0,
          promptOpen: false,
        }
      : undefined;
    restoreVimEditorDraft(tab, editorActions, snapshot.editorText);
  } else {
    tab.vimTranscriptSearch = undefined;
  }
}

function clearTransientSearchEditor(
  search: VimTranscriptSearchState,
  editorActions: MixCodeEditorActions,
): void {
  const query = search.query;
  const selectionMode = search.selectionMode;
  editorActions.setText("");
  search.query = query;
  search.selectionMode = selectionMode;
}

function restoreVimEditorDraft(
  tab: MixCodeTabInfo,
  editorActions: MixCodeEditorActions,
  text: string,
): void {
  editorActions.setText(text);
  tab.draftInput = text;
}
