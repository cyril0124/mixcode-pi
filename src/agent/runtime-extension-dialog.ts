import { matchesKey } from "@earendil-works/pi-tui";
import {
  ensureExtensionThemeInitialized,
  MIXCODE_EXTENSION_THEME,
} from "./runtime-extension-theme.js";
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
  _question: string,
  options: Array<{ label: string; description: string }>,
  _multiple: boolean,
  _custom: boolean,
  opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string | undefined> {
  const host = getCustomUiHost();
  if (!host?.editor?.setEditorComponent) {
    // Fallback: resolve immediately if editor host is unavailable
    return Promise.resolve(undefined);
  }
  ensureExtensionThemeInitialized();
  const sessionId = runtimeTab.tab.sessionId;
  const previousFactory = host.editor.getEditorComponent?.(sessionId);
  const previousText =
    host.editor.getExpandedText?.(sessionId) ?? host.editor.getText(sessionId) ?? "";

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let highlightedIndex = 0;
    // For input kind, track the custom text being typed
    let inputText = "";

    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", abort);
      runtimeTab.extensionCustomOverlayClosers.delete(abort);
      removeDialogInteraction(runtimeTab, interactionId);
      // Restore previous editor
      host.editor?.setEditorComponent?.(previousFactory, sessionId);
      host.editor?.setText(previousText, sessionId);
      resolve(result);
      requestRender();
    };

    const abort = () => finish(undefined);

    // Track as pending user interaction so agent waits
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

    const theme = MIXCODE_EXTENSION_THEME;

    const render = (width: number): string[] => {
      const innerWidth = Math.max(1, width - 2);
      const border = theme.fg("border", "─".repeat(Math.max(1, width)));
      const lines: string[] = [];

      lines.push("");
      lines.push(border);
      lines.push(`  ${theme.fg("accent", title)}`);

      if (kind === "input") {
        // Input mode: show a text input area
        lines.push(border);
        lines.push("");
        const cursor = inputText + "█";
        lines.push(`  ${cursor}`);
        lines.push("");
        lines.push(theme.fg("dim", "  enter: submit  esc: cancel"));
      } else {
        // Select/confirm mode: show options list
        lines.push(border);
        lines.push("");
        for (let i = 0; i < options.length; i++) {
          const marker = i === highlightedIndex ? theme.fg("accent", "›") : " ";
          const label = options[i].label;
          const desc = options[i].description
            ? `  ${theme.fg("dim", options[i].description)}`
            : "";
          const line = `${marker} ${label}${desc}`;
          if (i === highlightedIndex) {
            lines.push(theme.bg("selectedBg", padTo(`  ${line}`, innerWidth)));
          } else {
            lines.push(`  ${line}`);
          }
        }
        lines.push("");
        lines.push(theme.fg("dim", "  up/down: select  enter: choose  esc: cancel"));
      }

      lines.push("");
      lines.push(border);
      return lines;
    };

    const handleInput = (data: string): void => {
      if (settled) return;

      if (matchesKey(data, "escape")) {
        finish(undefined);
        return;
      }

      if (kind === "input") {
        // Input mode key handling
        if (matchesKey(data, "enter")) {
          finish(inputText || undefined);
          return;
        }
        // Backspace
        if (data === "\u007f" || matchesKey(data, "backspace")) {
          inputText = inputText.slice(0, -1);
          requestRender();
          return;
        }
        // Printable characters
        if (data.length === 1 && data >= "\x20" && data <= "\x7e") {
          inputText += data;
          requestRender();
          return;
        }
        // Paste sequences
        if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
          inputText += data.slice(6, -6);
          requestRender();
          return;
        }
        return;
      }

      // Select/confirm mode key handling
      if (matchesKey(data, "enter") || data === " ") {
        const selected = options[highlightedIndex];
        finish(selected?.label ?? undefined);
        return;
      }

      if (matchesKey(data, "up") || data === "k") {
        highlightedIndex = Math.max(0, highlightedIndex - 1);
        requestRender();
        return;
      }

      if (matchesKey(data, "down") || data === "j") {
        highlightedIndex = Math.min(options.length - 1, highlightedIndex + 1);
        requestRender();
        return;
      }
    };

    // Set the editor component
    host.editor!.setEditorComponent!(() => ({
      render,
      handleInput,
      invalidate: () => {},
      getText: () => "",
      setText: () => undefined,
    }), sessionId);
    requestRender();
  });
}

function padTo(text: string, width: number): string {
  // Simple padding without ANSI-aware width calculation
  // The visual width may differ from string length due to ANSI codes,
  // but this is sufficient for the selector UI
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function nextDialogInteractionId(runtimeTab: RuntimeTab): string {
  const prefix = "extension-dialog-";
  const maxIndex = runtimeTab.tab.extensionUi.pendingUserInteractions.reduce((max, interaction) => {
    if (!interaction.id.startsWith(prefix)) return max;
    const index = Number(interaction.id.slice(prefix.length));
    return Number.isInteger(index) ? Math.max(max, index) : max;
  }, 0);
  return `${prefix}${maxIndex + 1}`;
}

function addDialogInteraction(runtimeTab: RuntimeTab, id: string): void {
  runtimeTab.tab.extensionUi.pendingUserInteractions.push({ id, kind: "custom" });
}

function removeDialogInteraction(runtimeTab: RuntimeTab, id: string): void {
  runtimeTab.tab.extensionUi.pendingUserInteractions =
    runtimeTab.tab.extensionUi.pendingUserInteractions.filter(
      (interaction) => interaction.id !== id,
    );
}
