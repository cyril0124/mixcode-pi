import {
  type AutocompleteProvider,
  type Component,
  CURSOR_MARKER,
  Editor,
  type EditorComponent,
  type EditorTheme,
  isKeyRelease,
  matchesKey,
  type TUI as TuiType,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type EditorFactory, MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../agent/runtime.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import type { MixCodeEditorActions } from "./app-types.js";
import { renderEditorCardEdge } from "./components/editor-card.js";
import { exactContextUsageText } from "./rendering/chrome.js";
import { padLine } from "./rendering.js";
import { type MixCodeTheme, themeForId } from "./themes.js";
export class CompactPromptEditor extends Editor {
  private readonly rootTui: Pick<TuiType, "requestRender">;
  private lastThemeId = "";
  private cardWidth = 0;
  private hiddenLinesAbove = 0;
  private hiddenLinesBelow = 0;
  private renderedBottomFrame = "";

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
    if (this.mixState.activeTabId === HOME_TAB_ID) {
      // Allow typing on Agent View for sending messages to selected agent.
      super.handleInput(data);
      this.triggerSymbolAutocomplete(data);
      this.reopenDirectoryFileAutocomplete();
      this.closeStaleSymbolAutocomplete();
      this.rootTui.requestRender();
      return;
    }
    const active = this.activeTab();
    if (active?.vimMode) {
      this.rootTui.requestRender();
      return;
    }
    super.handleInput(data);
    this.triggerSymbolAutocomplete(data);
    this.reopenDirectoryFileAutocomplete();
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

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    this.hiddenLinesAbove = hiddenLineCount;
    return super.renderTopBorder(width, hiddenLineCount);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.hiddenLinesBelow = hiddenLineCount;
    // The rounded edge is two columns wider than body and completion rows,
    // making it an unambiguous delimiter in the rendered output.
    this.renderedBottomFrame = `╰${super.renderBottomBorder(width, hiddenLineCount)}╯`;
    return this.renderedBottomFrame;
  }

  override render(width: number): string[] {
    const theme = themeForId(this.mixState.theme);
    // Pi exposes no theme setter; keep its completion palette synchronized.
    if (this.mixState.theme !== this.lastThemeId) {
      this.lastThemeId = this.mixState.theme;
      (this as unknown as { theme: EditorTheme }).theme = editorThemeFor(theme);
    }
    this.cardWidth = width;
    // A wide grapheme cannot fit in Pi's one-column wrapping path. Preserve the
    // draft and focused cursor until the terminal can display the card again.
    if (width < 8) {
      return [(this.focused ? CURSOR_MARKER : "") + " ".repeat(Math.max(0, width))];
    }

    const home = this.mixState.activeTabId === HOME_TAB_ID;
    const active = home ? undefined : this.activeTab();
    const isVimMode = active?.vimMode === true;
    const currentText = this.getExpandedText?.() ?? this.getText();
    const isShellMode = currentText.trimStart().startsWith("!");
    const frame = isVimMode ? theme.vimBorder : theme.thinkingBorder(active?.thinkingLevel);
    this.borderColor = frame;
    const innerWidth = width - 2;
    const lines = super.render(innerWidth);
    const bottomIndex = lines.indexOf(this.renderedBottomFrame, 1);
    const body = lines.slice(1, bottomIndex);
    const completion = lines.slice(bottomIndex + 1);

    if (currentText.length === 0) {
      body[0] = isVimMode
        ? renderStaticPlaceholderLine(
            "Vim: → newer · Shift+→ older · j/k scroll · q exit",
            innerWidth,
            theme,
          )
        : renderPlaceholderLine(
            lines[1]!,
            home
              ? `${homeEditorPlaceholder(this.mixState)}  @ files  / commands`
              : "Describe your next change...  @ files  / commands  ← Home · → widgets",
            innerWidth,
            theme,
          );
    }

    const selected = home ? this.mixState.tabs[this.mixState.homeSelectedTabIndex] : active;
    const title = theme.accent(selected?.title ?? "New message");
    const badges: string[] = [];
    if (isVimMode) badges.push(theme.vimBorder("[VIM]"));
    else if (isShellMode) badges.push(theme.bashMode("[SHELL]"));
    if (active?.zenMode) badges.push(theme.dim("[ZEN]"));
    if (active?.customBasePrompt) badges.push(theme.dim("[sys]"));
    if (this.hiddenLinesAbove > 0) badges.push(theme.dim(`↑ ${this.hiddenLinesAbove}`));

    let context = active ? exactContextUsageText(active) : "";
    const nearLimit = active && (active.currentContextTokens ?? 0) >= active.contextLimit * 0.85;
    context = nearLimit ? theme.warning(context) : theme.dim(context);
    const top = renderEditorCardEdge(width, "top", title, context, theme, frame, badges.join(" "));
    const scrollHint =
      !isVimMode && this.hiddenLinesBelow > 0 ? theme.dim(`↓ ${this.hiddenLinesBelow} more`) : "";
    const bottom = renderEditorCardEdge(width, "bottom", scrollHint, "", theme, frame);
    const frameBody = (line: string) => `${frame("│")}${theme.text(line)}${frame("│")}`;
    return [top, ...body.map(frameBody), bottom, ...completion.map((line) => ` ${line} `)];
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.cardWidth < 8) return undefined;
    // Card rows match Pi's layout; only the side border shifts the input column.
    return super.handleMouse({ ...event, x: event.x - 1, width: event.width - 2 });
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

  /** After accepting a directory `@path/`, keep the file menu open for children. */
  private reopenDirectoryFileAutocomplete(): void {
    if (this.isShowingAutocomplete()) return;
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const token = currentEditorToken(line.slice(0, cursor.col));
    if (!token.startsWith("@")) return;
    const pathPart = token.slice(1).replace(/^"/, "").replace(/"$/, "");
    if (!pathPart.endsWith("/")) return;
    (
      this as unknown as { forceFileAutocomplete?: (explicitTab?: boolean) => void }
    ).forceFileAutocomplete?.(false);
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
  private inputComponentOverride: Component | undefined;
  private inputComponentSessionId: string | undefined;
  private autocompleteProvider: AutocompleteProvider | undefined;
  /** Union of extension trigger chars seen so far (multi-tab / late register). */
  private autocompleteTriggerCharacters = new Set<string>();
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

  // Resolve against the current tab without a full editor rebind or tab scan.
  private get inputTarget(): Component {
    const sessionId = this.mixState.activeTabId;
    if (this.inputComponentOverride && this.inputComponentSessionId === sessionId) {
      return this.inputComponentOverride;
    }
    if (sessionId === HOME_TAB_ID) return this.defaultEditor;
    return this.editorReplacements.get(sessionId)?.editor ?? this.defaultEditor;
  }

  get wantsKeyRelease(): boolean {
    return this.inputTarget.wantsKeyRelease === true;
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(focused: boolean) {
    this.focusState = focused;
    if (this.inputComponentOverride && this.inputComponentSessionId === this.mixState.activeTabId) {
      const focusable = this.inputComponentOverride as { focused?: boolean };
      if (focusable.focused !== undefined) focusable.focused = focused;
      return;
    }
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
    if (this.inputComponentOverride && this.inputComponentSessionId === this.mixState.activeTabId) {
      const lines = this.inputComponentOverride.render(width);
      return lines.map((line) => padLine(line, width));
    }
    if (this.mixState.activeTabId === HOME_TAB_ID) {
      // On Agent View, render the default editor (for sending messages).
      return this.defaultEditor.render(width);
    }
    const editor = this.activeEditor;
    this.syncEditorFocus();
    this.syncActiveEditorBorder(editor);
    const lines = editor.render(width);
    // Extension editor components may not pad lines to full width.
    // Ensure every line fills the terminal width so the differential
    // renderer clears leftover characters from previous frames.
    if (editor !== this.defaultEditor) {
      return lines.map((line) => padLine(line, width));
    }
    return lines;
  }

  invalidate(): void {
    this.activeEditor.invalidate();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) {
      // A release is component input, never history navigation or a draft edit.
      const target = this.inputTarget;
      if (target.wantsKeyRelease) target.handleInput?.(data);
      return;
    }
    if (this.inputComponentOverride && this.inputComponentSessionId === this.mixState.activeTabId) {
      const handler = (this.inputComponentOverride as { handleInput?: (data: string) => void })
        .handleInput;
      if (handler) {
        handler.call(this.inputComponentOverride, data);
        this.tui.requestRender();
      }
      return;
    }
    if (this.mixState.activeTabId === HOME_TAB_ID) {
      // Sync first: switching to Home clears the previous agent draft. Without
      // this, the first keystroke lands then getText()/render sync wipes it.
      this.syncActiveTab();
      // On Agent View, route input to the default editor for message composition.
      this.defaultEditor.handleInput(data);
      return;
    }
    this.syncActiveTab();
    const active = this.activeTab();
    if (active?.vimMode && active.extensionUi.waitingForInputs.length === 0) {
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
    if (this.isTakeoverSession(sessionId)) return this.draftForSession(sessionId);
    if (sessionId !== this.mixState.activeTabId) return this.textForSession(sessionId);
    this.syncActiveTab();
    return this.activeEditor.getText();
  }

  getExpandedText(sessionId = this.mixState.activeTabId): string {
    if (this.isTakeoverSession(sessionId)) return this.draftForSession(sessionId);
    if (sessionId !== this.mixState.activeTabId) return this.textForSession(sessionId, true);
    this.syncActiveTab();
    const editor = this.activeEditor;
    return editor.getExpandedText?.() ?? editor.getText();
  }

  setText(text: string, sessionId = this.mixState.activeTabId): void {
    if (this.isTakeoverSession(sessionId)) {
      this.setDraftInput(sessionId, text);
      if (sessionId === this.mixState.activeTabId) {
        this.syncActiveTab();
        this.defaultEditor.setText(text);
      }
      this.historyIndex = -1;
      this.tui.requestRender();
      return;
    }
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
    if (this.isTakeoverSession(sessionId)) {
      this.setText(`${this.draftForSession(sessionId)}${text}`, sessionId);
      return;
    }
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
    const active = this.activeTab();
    if (active?.vimMode) {
      this.tui.requestRender();
      return;
    }
    const editor = this.activeEditor;
    if (editor.insertTextAtCursor) editor.insertTextAtCursor(text);
    else editor.setText(`${editor.getText()}${text}`);
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

  browsePromptHistory(data: string): boolean {
    this.syncActiveTab();
    if (this.activeTab()?.vimMode) return false;
    return this.handleTabHistoryInput(data);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.autocompleteProvider = provider;
    // Pi Editor snapshots triggerCharacters at set time (not via live getter).
    // Materialize a plain list and accumulate so late addAutocompleteProvider
    // registrations (session_start) still enable triggers on custom skins.
    // Seed Pi defaults (@/#) so a "$"-only extension rebind never drops them
    // from our accumulated set used when rebinding multiple editors.
    for (const ch of ["@", "#"]) this.autocompleteTriggerCharacters.add(ch);
    for (const ch of provider.triggerCharacters ?? []) {
      if (ch.length === 1) this.autocompleteTriggerCharacters.add(ch);
    }
    const bound = bindAutocompleteProvider(provider, [...this.autocompleteTriggerCharacters]);
    this.defaultEditor.setAutocompleteProvider?.(bound);
    for (const replacement of this.editorReplacements.values()) {
      replacement.editor.setAutocompleteProvider?.(bound);
    }
  }

  isShowingAutocomplete(): boolean {
    const editor = this.activeEditor;
    return Boolean((editor as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.());
  }

  syncActiveTab(): void {
    const nextActiveTabId = this.mixState.activeTabId;
    if (this.activeTabId === nextActiveTabId) return;
    const previous = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    if (previous && !this.isTakeoverSession(previous.sessionId)) {
      previous.draftInput = this.activeEditor.getExpandedText?.() ?? this.activeEditor.getText();
    }
    this.activeTabId = nextActiveTabId;
    this.historyIndex = -1;
    const active = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    const replacement = this.editorReplacements.get(this.activeTabId);
    if (replacement) {
      this.activeEditor = replacement.editor;
      this.syncEditorFocus();
      return;
    }
    this.activeEditor = this.defaultEditor;
    this.applyDefaultEditorBindings();
    // Home is an ephemeral composer for the selected agent. Never carry the
    // previous agent buffer into config — that made Home send agent draft + new text.
    if (this.activeTabId === HOME_TAB_ID) {
      this.defaultEditor.setText("");
    } else if (active) {
      this.defaultEditor.setText(active.draftInput);
    }
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
    // Match Pi InteractiveMode.setCustomEditorComponent: copy appearance +
    // autocomplete via public Editor APIs only.
    if (nextEditor.borderColor !== undefined)
      nextEditor.borderColor = this.borderColorForSession(sessionId, nextEditor);
    nextEditor.setPaddingX?.(this.defaultEditor.getPaddingX());
    nextEditor.setAutocompleteMaxVisible?.(this.defaultEditor.getAutocompleteMaxVisible());
    this.editorReplacements.set(sessionId, { factory, editor: nextEditor });
    // Rebind all editors so the new skin gets a materialized trigger snapshot
    // (same as Pi calling setAutocompleteProvider after creating the custom editor).
    if (this.autocompleteProvider) this.setAutocompleteProvider(this.autocompleteProvider);
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

  setEmbeddedTerminalRows(
    rows: number | undefined,
    sessionId = this.mixState.activeTabId,
  ): boolean {
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

  setInputComponent(component: Component, sessionId = this.mixState.activeTabId): void {
    this.inputComponentOverride = component;
    this.inputComponentSessionId = sessionId;
    const focusable = component as { focused?: boolean };
    if (focusable.focused !== undefined) {
      // Force focused to true when setting input component
      focusable.focused = true;
      this.focusState = true;
    }
    this.tui.setFocus(this);
    this.tui.requestRender();
  }

  clearInputComponent(sessionId = this.mixState.activeTabId): void {
    if (this.inputComponentSessionId === sessionId) {
      this.inputComponentOverride = undefined;
      this.inputComponentSessionId = undefined;
      this.tui.setFocus(this);
      this.tui.requestRender();
    }
  }

  hasInputComponent(sessionId = this.mixState.activeTabId): boolean {
    return this.inputComponentOverride !== undefined && this.inputComponentSessionId === sessionId;
  }

  private deleteEditorMaxRows(sessionId: string): boolean {
    const changed = this.editorMaxRows.delete(sessionId);
    if (changed) this.tui.requestRender();
    return changed;
  }

  private handleTabHistoryInput(data: string): boolean {
    // Works for default and permanent setEditorComponent skins. Temporary
    // custom()/dialog takeovers own Up/Down; input-component overrides never
    // reach here (handleInput short-circuits earlier).
    if (!matchesKey(data, "up") && !matchesKey(data, "down")) return false;
    const active = this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
    if (!active || active.extensionUi.waitingForInputs.length > 0) return false;
    const browsing = this.historyIndex !== -1;
    if (
      matchesKey(data, "up") &&
      this.getExpandedText().trim() === "" &&
      active.promptHistory.length > 0
    ) {
      this.historyIndex = 0;
      this.activeEditor.setText(active.promptHistory[0] ?? "");
      return true;
    }
    if (matchesKey(data, "up") && browsing && this.historyIndex < active.promptHistory.length - 1) {
      this.historyIndex += 1;
      this.activeEditor.setText(active.promptHistory[this.historyIndex] ?? "");
      return true;
    }
    if (matchesKey(data, "down") && browsing) {
      this.historyIndex -= 1;
      this.activeEditor.setText(
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
    // Keep draft for both default and custom editors so history Down restores it.
    if (active)
      active.draftInput = this.activeEditor.getExpandedText?.() ?? this.activeEditor.getText();
  }

  private activeTab(): MixCodeState["tabs"][number] | undefined {
    return this.mixState.tabs.find((tab) => tab.sessionId === this.activeTabId);
  }

  // Temporary custom()/dialog takeovers replace the visible editor. Pi keeps
  // this.editor as the real editor, so get/setEditorText still read/write that
  // buffer. Route those primitives to draftInput instead of the stub wrapper.
  private isTakeoverSession(sessionId = this.mixState.activeTabId): boolean {
    if (this.hasInputComponent(sessionId)) return true;
    const tab = this.mixState.tabs.find((item) => item.sessionId === sessionId);
    return Boolean(tab?.extensionUi.waitingForInputs.length);
  }

  private draftForSession(sessionId: string): string {
    return this.mixState.tabs.find((item) => item.sessionId === sessionId)?.draftInput ?? "";
  }

  private textForSession(sessionId: string, expanded = false): string {
    const replacement = this.editorReplacements.get(sessionId)?.editor;
    if (replacement) {
      return expanded
        ? (replacement.getExpandedText?.() ?? replacement.getText())
        : replacement.getText();
    }
    return this.draftForSession(sessionId);
  }

  private setDraftInput(sessionId: string, text: string): void {
    const tab = this.mixState.tabs.find((item) => item.sessionId === sessionId);
    if (tab) tab.draftInput = text;
  }

  private applyDefaultEditorBindings(): void {
    this.defaultEditor.onSubmit = this.submitHandler;
    this.defaultEditor.onChange = this.changeHandler;
    if (this.autocompleteProvider) this.setAutocompleteProvider(this.autocompleteProvider);
  }

  private syncEditorFocus(): void {
    const focusedEditor = this.activeEditor;
    setFocusableState(this.defaultEditor, focusedEditor === this.defaultEditor && this.focused);
    for (const replacement of this.editorReplacements.values()) {
      setFocusableState(replacement.editor, replacement.editor === focusedEditor && this.focused);
    }
  }

  private syncActiveEditorBorder(editor = this.activeEditor): void {
    if (editor.borderColor === undefined) return;
    editor.borderColor = this.borderColorForSession(this.activeTabId, editor);
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
    if (text.trimStart().startsWith("!")) return theme.bashMode;
    return theme.thinkingBorder(tab?.thinkingLevel);
  }
}

export function addPromptHistory(
  tab: MixCodeState["tabs"][number] | undefined,
  text: string,
): void {
  const trimmed = text.trim();
  if (!tab || !trimmed) return;
  tab.promptHistory = [trimmed, ...tab.promptHistory.filter((item) => item !== trimmed)].slice(
    0,
    100,
  );
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

function renderStaticPlaceholderLine(
  placeholder: string,
  width: number,
  theme: MixCodeTheme,
): string {
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
      noMatch: theme.error,
    },
  };
}

/**
 * Pi Editor snapshots `provider.triggerCharacters` in setAutocompleteProvider.
 * Bind a plain array so custom skins receive extension triggers even when the
 * live provider exposes them via a getter (active-tab proxy).
 */
function bindAutocompleteProvider(
  provider: AutocompleteProvider,
  triggerCharacters: string[],
): AutocompleteProvider {
  // Match Pi Editor.forceFileAutocomplete: missing shouldTriggerFileCompletion
  // means "allow"; only an explicit false may cancel. Never coerce undefined→false.
  const bound: AutocompleteProvider = {
    triggerCharacters,
    getSuggestions: (lines, cursorLine, cursorCol, options) =>
      provider.getSuggestions(lines, cursorLine, cursorCol, options),
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
  };
  if (provider.shouldTriggerFileCompletion) {
    bound.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
      provider.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
  }
  return bound;
}
