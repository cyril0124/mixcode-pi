import {
  type AutocompleteProvider,
  type Component,
  Editor,
  type EditorComponent,
  type EditorTheme,
  matchesKey,
  type TUI as TuiType,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type EditorFactory, MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../agent/runtime.js";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeEditorActions } from "./app-types.js";
import { padLine } from "./rendering.js";
import { type MixCodeTheme, themeForId } from "./themes.js";
export class CompactPromptEditor extends Editor {
  private readonly rootTui: Pick<TuiType, "requestRender">;
  private lastThemeId = "";

  constructor(
    tui: TuiType,
    options: ConstructorParameters<typeof Editor>[1],
    editorOptions: ConstructorParameters<typeof Editor>[2],
    private readonly mixState: MixCodeState,
  ) {
    super(tui, options, editorOptions);
    this.rootTui = tui;
  }

  override handleInput(data: string): void {
    if (this.mixState.activeTabId === "config") {
      // Allow typing on Agent View for sending messages to selected agent.
      super.handleInput(data);
      this.triggerSymbolAutocomplete(data);
      this.closeStaleSymbolAutocomplete();
      this.rootTui.requestRender();
      return;
    }
    if (this.activeTab()?.vimMode) {
      this.rootTui.requestRender();
      return;
    }
    super.handleInput(data);
    this.triggerSymbolAutocomplete(data);
    this.closeStaleSymbolAutocomplete();
    this.rootTui.requestRender();
  }

  override setText(text: string): void {
    super.setText(text);
    this.rootTui.requestRender();
  }

  override insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(text);
    this.rootTui.requestRender();
  }

  override addToHistory(text: string): void {
    super.addToHistory(text);
    this.rootTui.requestRender();
  }

  override render(width: number): string[] {
    const theme = themeForId(this.mixState.theme);
    // Sync the base Editor's internal theme so autocomplete dropdown
    // colors (selectList) follow theme changes instead of staying frozen
    // at construction time. The private field is the only way — the Pi SDK
    // Editor provides no public setTheme / updateTheme API.
    if (this.mixState.theme !== this.lastThemeId) {
      this.lastThemeId = this.mixState.theme;
      (this as unknown as { theme: EditorTheme }).theme = editorThemeFor(theme);
    }
    if (this.mixState.activeTabId === "config") {
      // Render editor on Agent View with a placeholder targeting the selected agent.
      this.borderColor = theme.thinkingBorder();
      const lines = super.render(width);
      const currentText = this.getExpandedText?.() ?? this.getText();
      if (currentText.length === 0) {
        return lines.map((line, index) =>
          index === 1
            ? renderPlaceholderLine(line, homeEditorPlaceholder(this.mixState), width, theme)
            : line,
        );
      }
      return lines;
    }
    const isVimMode = this.activeTab()?.vimMode === true;
    const currentText = this.getExpandedText?.() ?? this.getText();
    const isEmpty = currentText.length === 0;
    const isShellMode = currentText.trimStart().startsWith("!");
    this.borderColor = isVimMode
      ? theme.vimBorder
      : isShellMode
        ? theme.shellBorder
        : theme.thinkingBorder(this.activeTab()?.thinkingLevel);
    const lines = super.render(width);
    if (!isEmpty) return lines;
    if (isVimMode) {
      return lines.map((line, index) =>
        index === 1 ? renderStaticPlaceholderLine("Vim mode, q to exit", width, theme) : line,
      );
    }
    return lines.map((line, index) =>
      index === 1
        ? renderPlaceholderLine(line, editorPlaceholder(this.mixState), width, theme)
        : line,
    );
  }

  private triggerSymbolAutocomplete(data: string): void {
    if (!isSymbolAutocompleteInput(data)) return;
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const token = currentEditorToken(line.slice(0, cursor.col));
    if (token.startsWith("$") || token.startsWith("@")) {
      (
        this as unknown as { forceFileAutocomplete?: (explicitTab?: boolean) => void }
      ).forceFileAutocomplete?.(false);
    }
  }

  private closeStaleSymbolAutocomplete(): void {
    if (!this.isShowingAutocomplete()) return;
    const autocompletePrefix =
      (this as unknown as { autocompletePrefix?: string }).autocompletePrefix ?? "";
    if (!autocompletePrefix.startsWith("$") && !autocompletePrefix.startsWith("@")) return;
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const token = currentEditorToken(line.slice(0, cursor.col));
    if (token.startsWith("$") || token.startsWith("@")) return;
    (this as unknown as { cancelAutocomplete?: () => void }).cancelAutocomplete?.();
  }

  private activeTab(): MixCodeState["tabs"][number] | undefined {
    return this.mixState.tabs.find((tab) => tab.sessionId === this.mixState.activeTabId);
  }
}

function editorPlaceholder(state: MixCodeState): string {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
  return `Send message to ${active?.title ?? "agent"}...`;
}

function homeEditorPlaceholder(state: MixCodeState): string {
  const selected = state.tabs[state.homeSelectedTabIndex];
  return selected ? `Send to ${selected.title}...` : "Select an agent...";
}

export class EditorSlot implements Component {
  private focusState = false;
  private activeEditor: EditorComponent;
  private readonly editorReplacements = new Map<
    string,
    { factory: EditorFactory; editor: EditorComponent }
  >();
  private autocompleteProvider: AutocompleteProvider | undefined;
  private submitHandler: ((text: string) => void) | undefined;
  private changeHandler: ((text: string) => void) | undefined;
  private readonly embeddedTerminalRows = new Map<string, number>();
  private readonly editorMaxRows = new Map<string, number>();
  private activeTabId = "";
  private historyIndex = -1;

  constructor(
    private readonly tui: TuiType,
    private readonly defaultEditor: CompactPromptEditor,
    private readonly mixState: MixCodeState,
  ) {
    this.activeEditor = defaultEditor;
  }

  get current(): EditorComponent {
    this.syncActiveTab();
    return this.activeEditor;
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(focused: boolean) {
    this.focusState = focused;
    this.syncEditorFocus();
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.submitHandler = handler;
    this.defaultEditor.onSubmit = handler;
    for (const replacement of this.editorReplacements.values()) {
      replacement.editor.onSubmit = handler;
    }
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.changeHandler = handler;
    this.defaultEditor.onChange = handler;
    for (const replacement of this.editorReplacements.values()) {
      replacement.editor.onChange = handler;
    }
  }

  render(width: number): string[] {
    this.syncActiveTab();
    if (this.mixState.activeTabId === "config") {
      // On Agent View, render the default editor (for sending messages).
      return this.defaultEditor.render(width);
    }
    this.syncActiveEditorBorder();
    const lines = this.activeEditor.render(width);
    // Extension editor components may not pad lines to full width.
    // Ensure every line fills the terminal width so the differential
    // renderer clears leftover characters from previous frames.
    if (this.activeEditor !== this.defaultEditor) {
      return lines.map((line) => padLine(line, width));
    }
    return lines;
  }

  invalidate(): void {
    this.activeEditor.invalidate();
  }

  handleInput(data: string): void {
    if (this.mixState.activeTabId === "config") {
      // On Agent View, route input to the default editor for message composition.
      this.defaultEditor.handleInput(data);
      return;
    }
    this.syncActiveTab();
    if (this.activeTab()?.vimMode) {
      this.tui.requestRender();
      return;
    }
    if (this.handleTabHistoryInput(data)) {
      this.tui.requestRender();
      return;
    }
    this.activeEditor.handleInput(data);
    this.updateActiveTabDraft();
    this.historyIndex = -1;
    this.tui.requestRender();
  }

  getText(sessionId = this.mixState.activeTabId): string {
    if (sessionId !== this.mixState.activeTabId) return this.textForSession(sessionId);
    this.syncActiveTab();
    return this.activeEditor.getText();
  }

  getExpandedText(sessionId = this.mixState.activeTabId): string {
    if (sessionId !== this.mixState.activeTabId) return this.textForSession(sessionId, true);
    this.syncActiveTab();
    return this.activeEditor.getExpandedText?.() ?? this.activeEditor.getText();
  }

  setText(text: string, sessionId = this.mixState.activeTabId): void {
    if (sessionId !== this.mixState.activeTabId) {
      const replacement = this.editorReplacements.get(sessionId);
      if (replacement) replacement.editor.setText(text);
      else this.setDraftInput(sessionId, text);
      this.tui.requestRender();
      return;
    }
    this.syncActiveTab();
    this.activeEditor.setText(text);
    this.updateActiveTabDraft();
    this.historyIndex = -1;
    this.tui.requestRender();
  }

  pasteToEditor(text: string, sessionId = this.mixState.activeTabId): void {
    if (sessionId !== this.mixState.activeTabId) {
      const replacement = this.editorReplacements.get(sessionId);
      if (replacement) replacement.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
      else this.setDraftInput(sessionId, `${this.textForSession(sessionId, true)}${text}`);
      this.tui.requestRender();
      return;
    }
    this.handleInput(`\x1b[200~${text}\x1b[201~`);
  }

  addToHistory(text: string, sessionId = this.mixState.activeTabId): void {
    const tab = this.mixState.tabs.find((item) => item.sessionId === sessionId);
    addPromptHistory(tab, text);
    if (sessionId === this.activeTabId && this.activeEditor !== this.defaultEditor)
      this.activeEditor.addToHistory?.(text);
    if (sessionId === this.activeTabId) this.historyIndex = -1;
    this.tui.requestRender();
  }

  insertTextAtCursor(text: string): void {
    this.syncActiveTab();
    if (this.activeTab()?.vimMode) {
      this.tui.requestRender();
      return;
    }
    if (this.activeEditor.insertTextAtCursor) this.activeEditor.insertTextAtCursor(text);
    else this.activeEditor.setText(`${this.activeEditor.getText()}${text}`);
    this.updateActiveTabDraft();
    this.historyIndex = -1;
    this.tui.requestRender();
  }

  submitCurrentText(): void {
    this.syncActiveTab();
    if (this.activeTab()?.vimMode) return;
    const text = this.getExpandedText().trim();
    this.setText("");
    this.activeEditor.onSubmit?.(text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.autocompleteProvider = provider;
    this.defaultEditor.setAutocompleteProvider?.(provider);
    for (const replacement of this.editorReplacements.values()) {
      replacement.editor.setAutocompleteProvider?.(provider);
    }
  }

  isShowingAutocomplete(): boolean {
    return Boolean(
      (this.activeEditor as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.(),
    );
  }

  syncActiveTab(): void {
    const nextActiveTabId = this.mixState.activeTabId;
    if (this.activeTabId === this.mixState.activeTabId) return;
    const previous = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    if (previous && this.activeEditor === this.defaultEditor)
      previous.draftInput = this.defaultEditor.getExpandedText?.() ?? this.defaultEditor.getText();
    this.activeTabId = nextActiveTabId;
    this.historyIndex = -1;
    const replacement = this.editorReplacements.get(this.activeTabId);
    if (replacement) {
      this.activeEditor = replacement.editor;
      this.syncEditorFocus();
      return;
    }
    this.activeEditor = this.defaultEditor;
    this.applyDefaultEditorBindings();
    const active = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    if (active) this.defaultEditor.setText(active.draftInput);
    this.syncEditorFocus();
  }

  setEditorComponent(
    factory: EditorFactory | undefined,
    sessionId = this.mixState.activeTabId,
  ): void {
    const currentText = this.getExpandedText(sessionId);
    if (!factory) {
      this.editorReplacements.delete(sessionId);
      this.embeddedTerminalRows.delete(sessionId);
      this.editorMaxRows.delete(sessionId);
      this.setDraftInput(sessionId, currentText);
      if (sessionId === this.mixState.activeTabId) {
        this.defaultEditor.setText(currentText);
        this.activeEditor = this.defaultEditor;
        this.syncActiveEditorBorder();
      }
      this.applyDefaultEditorBindings();
      this.tui.setFocus(this);
      this.tui.requestRender();
      return;
    }
    const nextEditor = factory(
      this.tui,
      editorThemeFor(themeForId(this.mixState.theme)),
      MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
    );
    nextEditor.onSubmit = this.submitHandler;
    nextEditor.onChange = this.changeHandler;
    nextEditor.setText(currentText);
    if (nextEditor.borderColor !== undefined)
      nextEditor.borderColor = this.borderColorForSession(sessionId, nextEditor);
    nextEditor.setPaddingX?.(this.defaultEditor.getPaddingX());
    if (this.autocompleteProvider) nextEditor.setAutocompleteProvider?.(this.autocompleteProvider);
    this.editorReplacements.set(sessionId, { factory, editor: nextEditor });
    if (sessionId === this.mixState.activeTabId) {
      this.activeEditor = nextEditor;
      this.syncActiveEditorBorder();
      this.syncEditorFocus();
      this.tui.setFocus(this);
    }
    this.tui.requestRender();
  }

  getEditorComponent(sessionId = this.mixState.activeTabId): EditorFactory | undefined {
    return this.editorReplacements.get(sessionId)?.factory;
  }

  setEmbeddedTerminalRows(rows: number | undefined, sessionId = this.mixState.activeTabId): boolean {
    if (rows === undefined) {
      const changed = this.embeddedTerminalRows.delete(sessionId);
      if (changed) this.tui.requestRender();
      return changed;
    }
    const nextRows = Math.max(1, Math.floor(rows));
    if (this.embeddedTerminalRows.get(sessionId) === nextRows) return false;
    this.embeddedTerminalRows.set(sessionId, nextRows);
    this.tui.requestRender();
    return true;
  }

  getEmbeddedTerminalRows(sessionId = this.mixState.activeTabId): number | undefined {
    return this.embeddedTerminalRows.get(sessionId);
  }

  setEditorMaxRows(rows: number | undefined, sessionId = this.mixState.activeTabId): boolean {
    if (rows === undefined) return this.deleteEditorMaxRows(sessionId);
    const nextRows = Math.max(1, Math.floor(rows));
    if (this.editorMaxRows.get(sessionId) === nextRows) return false;
    this.editorMaxRows.set(sessionId, nextRows);
    this.tui.requestRender();
    return true;
  }

  getEditorMaxRows(sessionId = this.mixState.activeTabId): number | undefined {
    return this.editorMaxRows.get(sessionId);
  }

  private deleteEditorMaxRows(sessionId: string): boolean {
    const changed = this.editorMaxRows.delete(sessionId);
    if (changed) this.tui.requestRender();
    return changed;
  }

  private handleTabHistoryInput(data: string): boolean {
    if (this.activeEditor !== this.defaultEditor) return false;
    if (!matchesKey(data, "up") && !matchesKey(data, "down")) return false;
    const active = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    if (!active) return false;
    const browsing = this.historyIndex !== -1;
    if (
      matchesKey(data, "up") &&
      this.getExpandedText().trim() === "" &&
      active.promptHistory.length > 0
    ) {
      this.historyIndex = 0;
      this.defaultEditor.setText(active.promptHistory[0] ?? "");
      return true;
    }
    if (matchesKey(data, "up") && browsing && this.historyIndex < active.promptHistory.length - 1) {
      this.historyIndex += 1;
      this.defaultEditor.setText(active.promptHistory[this.historyIndex] ?? "");
      return true;
    }
    if (matchesKey(data, "down") && browsing) {
      this.historyIndex -= 1;
      this.defaultEditor.setText(
        this.historyIndex === -1
          ? active.draftInput
          : (active.promptHistory[this.historyIndex] ?? ""),
      );
      return true;
    }
    return false;
  }

  private updateActiveTabDraft(): void {
    const active = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    if (active && this.activeEditor === this.defaultEditor)
      active.draftInput = this.defaultEditor.getExpandedText?.() ?? this.defaultEditor.getText();
  }

  private activeTab(): MixCodeState["tabs"][number] | undefined {
    return this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
  }

  private textForSession(sessionId: string, expanded = false): string {
    const replacement = this.editorReplacements.get(sessionId)?.editor;
    if (replacement) {
      return expanded
        ? (replacement.getExpandedText?.() ?? replacement.getText())
        : replacement.getText();
    }
    return this.mixState.tabs.find((tab) => tab.sessionId === sessionId)?.draftInput ?? "";
  }

  private setDraftInput(sessionId: string, text: string): void {
    const tab = this.mixState.tabs.find((item) => item.sessionId === sessionId);
    if (tab) tab.draftInput = text;
  }

  private applyDefaultEditorBindings(): void {
    this.defaultEditor.onSubmit = this.submitHandler;
    this.defaultEditor.onChange = this.changeHandler;
    if (this.autocompleteProvider)
      this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
  }

  private syncEditorFocus(): void {
    setFocusableState(this.defaultEditor, this.activeEditor === this.defaultEditor && this.focused);
    for (const replacement of this.editorReplacements.values()) {
      setFocusableState(
        replacement.editor,
        replacement.editor === this.activeEditor && this.focused,
      );
    }
  }

  private syncActiveEditorBorder(): void {
    if (this.activeEditor.borderColor === undefined) return;
    this.activeEditor.borderColor = this.borderColorForSession(
      this.activeTabId,
      this.activeEditor,
    );
  }

  private borderColorForSession(
    sessionId: string,
    editor: EditorComponent,
  ): (text: string) => string {
    const theme = themeForId(this.mixState.theme);
    const text =
      sessionId === this.mixState.activeTabId
        ? (editor.getExpandedText?.() ?? editor.getText())
        : this.textForSession(sessionId, true);
    const tab = this.mixState.tabs.find((item) => item.sessionId === sessionId);
    if (tab?.vimMode) return theme.vimBorder;
    if (text.trimStart().startsWith("!")) return theme.shellBorder;
    return theme.thinkingBorder(tab?.thinkingLevel);
  }
}

export function addPromptHistory(
  tab: MixCodeState["tabs"][number] | undefined,
  text: string,
): void {
  const trimmed = text.trim();
  if (!tab || !trimmed) return;
  if (tab.promptHistory[0] === trimmed) return;
  tab.promptHistory.unshift(trimmed);
  if (tab.promptHistory.length > 100) tab.promptHistory.pop();
}
export function insertEditorText(editorActions: MixCodeEditorActions, text: string): void {
  if (editorActions.insertTextAtCursor) {
    editorActions.insertTextAtCursor(text);
    return;
  }
  editorActions.setText(editorActions.getText() + text);
}

function isSymbolAutocompleteInput(data: string): boolean {
  if (data === "$" || data === "@") return true;
  if (data.length !== 1) return false;
  return /[A-Za-z0-9_-]/.test(data);
}

function currentEditorToken(text: string): string {
  const match = text.match(/(?:^|\s)([$@][^\s"]*|@"[^"]*)$/);
  return match?.[1] ?? "";
}

function renderPlaceholderLine(
  editorCursorLine: string,
  placeholder: string,
  width: number,
  theme: MixCodeTheme,
): string {
  const trailingWidth = width - visibleWidth(editorCursorLine.trimEnd());
  const cursorPadding = trailingWidth > 0 ? " ".repeat(trailingWidth) : "";
  const cursor = editorCursorLine.slice(0, editorCursorLine.length - cursorPadding.length);
  const available = Math.max(0, width - visibleWidth(cursor));
  return padLine(`${cursor}${theme.dim(truncateToWidth(placeholder, available))}`, width);
}

function renderStaticPlaceholderLine(placeholder: string, width: number, theme: MixCodeTheme): string {
  const prefix = " ";
  const available = Math.max(0, width - prefix.length);
  return padLine(`${prefix}${theme.dim(truncateToWidth(placeholder, available))}`, width);
}

function setFocusableState(component: EditorComponent, focused: boolean): void {
  if ("focused" in component) {
    (component as EditorComponent & { focused: boolean }).focused = focused;
  }
}

export function editorThemeFor(theme: MixCodeTheme): EditorTheme {
  return {
    borderColor: theme.border,
    selectList: {
      selectedPrefix: theme.accent,
      selectedText: theme.accent,
      description: theme.dim,
      scrollInfo: theme.dim,
      noMatch: theme.danger,
    },
  };
}
