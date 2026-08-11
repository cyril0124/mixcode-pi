import {
  ExtensionInputComponent,
  ExtensionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI as PiTui } from "@earendil-works/pi-tui";

import {
  addWaitingForInput,
  removeWaitingForInput,
} from "./runtime-extension-custom.js";
import { ensureExtensionThemeInitialized } from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import type { ExtensionCustomUiHost, RuntimeTab } from "./runtime-types.js";

/**
 * Renders an extension dialog (select/confirm/input) in the EditorSlot,
 * matching Pi agent behavior where extension selectors replace the editor area.
 */
export function createExtensionDialog(
  runtimeTab: RuntimeTab,
  requestRender: () => void,
  getCustomUiHost: () => ExtensionCustomUiHost | undefined,
  kind: "select" | "confirm" | "input",
  title: string,
  question: string,
  options: Array<{ label: string; description: string }>,
  _multiple: boolean,
  _custom: boolean,
  opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string | undefined> {
  const host = getCustomUiHost();
  if (!host?.editor?.setEditorComponent) {
    // Match custom/editor: missing host is an environment error, not user cancel.
    throw new Error(
      `Pi extension UI primitive requires an active MixCode TUI host: ${kind}`,
    );
  }
  ensureExtensionThemeInitialized();
  const sessionId = runtimeTab.tab.sessionId;
  const previousFactory = host.editor.getEditorComponent?.(sessionId);
  const previousText =
    host.editor.getExpandedText?.(sessionId) ?? host.editor.getText(sessionId) ?? "";

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let component: (Component & { dispose?(): void }) | undefined;

    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", abort);
      runtimeTab.extensionCustomOverlayClosers.delete(abort);
      removeDialogInteraction(runtimeTab, interactionId);
      try {
        component?.dispose?.();
        // Restore previous editor
        host.editor?.setEditorComponent?.(previousFactory, sessionId);
        host.editor?.setText(previousText, sessionId);
      } finally {
        resolve(result);
        requestRender();
      }
    };

    const abort = () => finish(undefined);

    // Track as waitingForInput so agent waits
    const interactionId = nextDialogInteractionId(runtimeTab);
    addDialogInteraction(runtimeTab, interactionId);
    runtimeTab.extensionCustomOverlayClosers.add(abort);

    // Handle abort signal
    if (opts?.signal) {
      if (opts.signal.aborted) {
        abort();
        return;
      }
      opts.signal.addEventListener("abort", abort, { once: true });
    }

    // Handle timeout
    if (opts?.timeout !== undefined) {
      timeout = setTimeout(abort, Math.max(0, opts.timeout));
      timeout.unref?.();
    }

    host.editor!.setEditorComponent!(
      (tui, _theme, _keybindings) => {
        // Pi confirm joins title + message into the selector header so the body
        // is visible (interactive-mode showExtensionConfirm).
        const selectorTitle =
          kind === "confirm" ? `${title}\n${question}` : title;
        component =
          kind === "input"
            ? new ExtensionInputComponent(
                title,
                question,
                (value) => finish(value || undefined),
                abort,
                {
                  tui,
                  timeout: opts?.timeout,
                },
              )
            : new ExtensionSelectorComponent(
                selectorTitle,
                options.map((option) => option.label),
                finish,
                abort,
                {
                  tui,
                  timeout: opts?.timeout,
                  onToggleToolsExpanded: () => {
                    runtimeTab.tab.extensionUi.toolsExpanded =
                      !runtimeTab.tab.extensionUi.toolsExpanded;
                    requestRender();
                  },
                },
              );
        return extensionComponentEditor(component, tui);
      },
      sessionId,
    );
    requestRender();
  });
}

function extensionComponentEditor(component: Component, tui: PiTui | undefined) {
  return {
    render: (width: number) => {
      const restoreKeybindings = applyMixCodeKeybindings();
      try {
        ensureExtensionThemeInitialized();
        return component.render(width);
      } finally {
        restoreKeybindings();
      }
    },
    handleInput: (data: string) => {
      const restoreKeybindings = applyMixCodeKeybindings();
      try {
        ensureExtensionThemeInitialized();
        (component as Component & { handleInput?: (input: string) => void }).handleInput?.(data);
        tui?.requestRender();
      } finally {
        restoreKeybindings();
      }
    },
    invalidate: () => component.invalidate(),
    getText: () => "",
    setText: () => undefined,
  };
}

function nextDialogInteractionId(runtimeTab: RuntimeTab): string {
  const prefix = "extension-dialog-";
  const maxIndex = runtimeTab.tab.extensionUi.waitingForInputs.reduce((max, interaction) => {
    if (!interaction.id.startsWith(prefix)) return max;
    const index = Number(interaction.id.slice(prefix.length));
    return Number.isInteger(index) ? Math.max(max, index) : max;
  }, 0);
  return `${prefix}${maxIndex + 1}`;
}

function addDialogInteraction(runtimeTab: RuntimeTab, id: string): void {
  // Dialog focus is tracked via waitingForInputs. Do not change panelOpen:
  // the widget side panel is user-owned; key/mouse routing blocks it while pending.
  addWaitingForInput(runtimeTab, id, "custom");
}

function removeDialogInteraction(runtimeTab: RuntimeTab, id: string): void {
  removeWaitingForInput(runtimeTab, id);
}
