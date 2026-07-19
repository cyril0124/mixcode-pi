import { ExtensionEditorComponent } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import {
  ensureExtensionThemeInitialized,
  MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
  currentExtensionTheme,
} from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import { createTerminalRowsProxy } from "./runtime-tui-proxy.js";
import type {
  ExtensionCustomComponent,
  ExtensionCustomFactory,
  ExtensionCustomOptions,
  ExtensionCustomUiHost,
  RuntimeTab,
} from "./runtime-types.js";

function nextPendingInteractionId(runtimeTab: RuntimeTab, kind: "custom" | "editor"): string {
  const prefix = `extension-${kind}-`;
  const maxIndex = runtimeTab.tab.extensionUi.pendingUserInteractions.reduce((max, interaction) => {
    if (!interaction.id.startsWith(prefix)) return max;
    const index = Number(interaction.id.slice(prefix.length));
    return Number.isInteger(index) ? Math.max(max, index) : max;
  }, 0);
  return `${prefix}${maxIndex + 1}`;
}

function addPendingUserInteraction(runtimeTab: RuntimeTab, id: string, kind: "custom" | "editor") {
  // Side-panel open/close is user-owned (→ toggle). Pending interactions only
  // take input focus via pendingUserInteractions guards — they must not change
  // panelOpen, or every extension UI (custom/dialog/editor) would dismiss it.
  runtimeTab.tab.extensionUi.pendingUserInteractions.push({ id, kind });
}

function removePendingUserInteraction(runtimeTab: RuntimeTab, id: string): void {
  runtimeTab.tab.extensionUi.pendingUserInteractions =
    runtimeTab.tab.extensionUi.pendingUserInteractions.filter(
      (interaction) => interaction.id !== id,
    );
}

export function createExtensionCustomOverlay<T>(
  runtimeTab: RuntimeTab,
  requestRender: () => void,
  getCustomUiHost: () => ExtensionCustomUiHost | undefined,
  factory: ExtensionCustomFactory<T>,
  options?: ExtensionCustomOptions,
): Promise<T> {
  const host = getCustomUiHost();
  if (!host)
    throw new Error("Pi extension UI primitive requires an active MixCode TUI host: custom");
  ensureExtensionThemeInitialized();
  if (options?.overlay !== true) {
    return createExtensionCustomEditor(runtimeTab, requestRender, host, factory);
  }
  return new Promise<T>((resolve, reject) => {
    let component: ExtensionCustomComponent | undefined;
    let handle: OverlayHandle | undefined;
    let settled = false;
    const interactionId = nextPendingInteractionId(runtimeTab, "custom");
    addPendingUserInteraction(runtimeTab, interactionId, "custom");
    const close = (result: T) => {
      if (settled) return;
      settled = true;
      runtimeTab.extensionCustomOverlayClosers.delete(closeWithoutResult);
      if (handle) runtimeTab.extensionCustomOverlayHandles.delete(handle);
      removePendingUserInteraction(runtimeTab, interactionId);
      handle?.hide();
      try {
        component?.dispose?.();
      } finally {
        resolve(result);
        requestRender();
      }
    };
    const closeWithoutResult = () => close(undefined as T);
    runtimeTab.extensionCustomOverlayClosers.add(closeWithoutResult);
    Promise.resolve()
      .then(() =>
        factory(
          host.tui,
          currentExtensionTheme(host.themes),
          MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
          close,
        ),
      )
      .then((createdComponent) => {
        if (settled) {
          createdComponent.dispose?.();
          return;
        }
        component = normalizeExtensionCustomComponent(createdComponent);
        sanitizeComponentRender(component);
        const overlayOptions = scopeOverlayOptionsToTab(
          resolveExtensionOverlayOptions(options, component),
          runtimeTab,
          host,
        );
        handle = host.tui.showOverlay(component, overlayOptions);
        runtimeTab.extensionCustomOverlayHandles.add(handle);
        options?.onHandle?.(handle);
        requestRender();
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        runtimeTab.extensionCustomOverlayClosers.delete(closeWithoutResult);
        if (handle) runtimeTab.extensionCustomOverlayHandles.delete(handle);
        removePendingUserInteraction(runtimeTab, interactionId);
        try {
          component?.dispose?.();
        } finally {
          requestRender();
          reject(error);
        }
      });
  });
}

function createExtensionCustomEditor<T>(
  runtimeTab: RuntimeTab,
  requestRender: () => void,
  host: ExtensionCustomUiHost,
  factory: ExtensionCustomFactory<T>,
): Promise<T> {
  if (!host.editor?.setEditorComponent)
    throw new Error("Pi extension UI editor component replacement is not available in MixCode yet");
  return new Promise<T>((resolve, reject) => {
    let component: ExtensionCustomComponent | undefined;
    let settled = false;
    const sessionId = runtimeTab.tab.sessionId;
    const previousFactory = host.editor?.getEditorComponent?.(sessionId);
    const previousText =
      host.editor?.getExpandedText?.(sessionId) ?? host.editor?.getText?.(sessionId) ?? "";
    const interactionId = nextPendingInteractionId(runtimeTab, "custom");
    const close = (result: T) => {
      if (settled) return;
      settled = true;
      runtimeTab.extensionCustomOverlayClosers.delete(closeWithoutResult);
      removePendingUserInteraction(runtimeTab, interactionId);
      try {
        host.editor?.setEditorComponent?.(previousFactory, sessionId);
        host.editor?.setText(previousText, sessionId);
        component?.dispose?.();
      } finally {
        resolve(result);
        requestRender();
      }
    };
    const closeWithoutResult = () => close(undefined as T);
    runtimeTab.extensionCustomOverlayClosers.add(closeWithoutResult);
    addPendingUserInteraction(runtimeTab, interactionId, "custom");
    const tui = createTerminalRowsProxy(host.tui, () =>
      host.editor?.getEmbeddedTerminalRows?.(sessionId),
    );
    Promise.resolve()
      .then(() =>
        factory(
          tui,
          currentExtensionTheme(host.themes),
          MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
          close,
        ),
      )
      .then((createdComponent) => {
        if (settled) {
          createdComponent.dispose?.();
          return;
        }
        component = normalizeExtensionCustomComponent(createdComponent);
        host.editor?.setEditorComponent?.(() => customComponentEditor(component!), sessionId);
        requestRender();
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        runtimeTab.extensionCustomOverlayClosers.delete(closeWithoutResult);
        removePendingUserInteraction(runtimeTab, interactionId);
        try {
          component?.dispose?.();
        } finally {
          requestRender();
          reject(error);
        }
      });
  });
}

function customComponentEditor(component: ExtensionCustomComponent) {
  return {
    render: (width: number) => renderWithPiExtensionContext(() => component.render(width)),
    handleInput: (data: string) =>
      renderWithPiExtensionContext(() => component.handleInput?.(data)),
    invalidate: () => renderWithPiExtensionContext(() => component.invalidate()),
    getText: () => "",
    setText: () => undefined,
    wantsKeyRelease: component.wantsKeyRelease,
  };
}

function renderWithPiExtensionContext<T>(render: () => T): T {
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    ensureExtensionThemeInitialized();
    return render();
  } finally {
    restoreKeybindings();
  }
}

// Matches Pi agent behavior: the extension editor replaces the input editor
// in place (EditorSlot swap), the same pattern createExtensionDialog uses for
// select/confirm/input, rather than floating as a centered overlay.
export function createExtensionEditorOverlay(
  runtimeTab: RuntimeTab,
  requestRender: () => void,
  getCustomUiHost: () => ExtensionCustomUiHost | undefined,
  title: string,
  prefill?: string,
): Promise<string | undefined> {
  const host = getCustomUiHost();
  if (!host?.editor?.setEditorComponent)
    throw new Error("Pi extension UI primitive requires an active MixCode TUI host: editor");
  const editor = host.editor;
  const setEditorComponent = editor.setEditorComponent!;
  ensureExtensionThemeInitialized();
  const sessionId = runtimeTab.tab.sessionId;
  const previousFactory = editor.getEditorComponent?.(sessionId);
  const previousText = editor.getExpandedText?.(sessionId) ?? editor.getText(sessionId) ?? "";
  return new Promise<string | undefined>((resolve) => {
    let component: ExtensionEditorComponent | undefined;
    let settled = false;
    const interactionId = nextPendingInteractionId(runtimeTab, "editor");
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      runtimeTab.extensionCustomOverlayClosers.delete(cancel);
      removePendingUserInteraction(runtimeTab, interactionId);
      setEditorComponent(previousFactory, sessionId);
      editor.setText(previousText, sessionId);
      resolve(value);
      requestRender();
    };
    const cancel = () => finish(undefined);
    runtimeTab.extensionCustomOverlayClosers.add(cancel);
    addPendingUserInteraction(runtimeTab, interactionId, "editor");
    const tui = createTerminalRowsProxy(host.tui, () => editor.getEmbeddedTerminalRows?.(sessionId));
    // ExtensionEditorComponent bakes its hint row (including the "external
    // editor" ctrl+e label) in its constructor via keyHint(), which reads the
    // pi-tui GLOBAL keybindings. Construct it inside the MixCode keybindings
    // scope so app.editor.external resolves; renderWithPiExtensionContext only
    // covers later render/input, not this one-time construction.
    const restoreKeybindings = applyMixCodeKeybindings();
    try {
      component = new ExtensionEditorComponent(
        tui,
        MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
        title,
        prefill,
        finish,
        cancel,
        { autocompleteMaxVisible: 8 },
      );
    } finally {
      restoreKeybindings();
    }
    setEditorComponent(() => customComponentEditor(component!), sessionId);
    requestRender();
  });
}

export function closeExtensionCustomOverlays(runtimeTab: RuntimeTab): void {
  for (const close of [...runtimeTab.extensionCustomOverlayClosers]) close();
  runtimeTab.extensionCustomOverlayClosers.clear();
}

function normalizeExtensionCustomComponent(
  component: ExtensionCustomComponent,
): ExtensionCustomComponent {
  if (component.handleInput || !component.onInput) return component;
  return {
    ...component,
    handleInput: (data: string) => component.onInput?.(data),
  };
}

function resolveExtensionOverlayOptions(
  options: ExtensionCustomOptions,
  component: Component,
): OverlayOptions | undefined {
  if (options?.overlayOptions) {
    return typeof options.overlayOptions === "function"
      ? options.overlayOptions()
      : options.overlayOptions;
  }
  const width = (component as { width?: unknown }).width;
  return typeof width === "number" ? { width } : undefined;
}

function scopeOverlayOptionsToTab(
  options: OverlayOptions | undefined,
  runtimeTab: RuntimeTab,
  host: ExtensionCustomUiHost,
): OverlayOptions {
  const visible = options?.visible;
  const scoped =
    host.isSessionActive || visible
      ? {
          ...(options ?? {}),
          visible: (termWidth: number, termHeight: number) => {
            if (host.isSessionActive && !host.isSessionActive(runtimeTab.tab.sessionId))
              return false;
            return visible ? visible(termWidth, termHeight) : true;
          },
        }
      : { ...(options ?? {}) };
  const topReservedRows = Math.max(
    0,
    Math.floor(host.topReservedRows?.(runtimeTab.tab.sessionId) ?? 0),
  );
  if (topReservedRows === 0) return scoped;
  const margin = normalizeOverlayMargin(scoped.margin);
  return {
    ...scoped,
    margin: {
      ...margin,
      top: Math.max(margin.top ?? 0, topReservedRows),
    },
  };
}

function normalizeOverlayMargin(margin: OverlayOptions["margin"]): {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
} {
  if (typeof margin === "number")
    return { top: margin, right: margin, bottom: margin, left: margin };
  return margin ? { ...margin } : {};
}

/**
 * Wrap a component's render to flatten embedded newlines into separate lines.
 * Extension components may produce lines containing literal \n (e.g. from
 * multi-line prompt text). The TUI differential renderer assumes each array
 * element is a single terminal row; embedded newlines break cursor positioning.
 */
function sanitizeComponentRender(component: ExtensionCustomComponent): void {
  const originalRender = component.render.bind(component);
  component.render = (width: number): string[] => {
    const raw = originalRender(width);
    const result: string[] = [];
    for (const line of raw) {
      if (line.includes("\n")) {
        for (const sub of line.split("\n")) result.push(sub);
      } else {
        result.push(line);
      }
    }
    return result;
  };
}
