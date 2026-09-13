import { isBashAlreadyRunningError } from "../agent/runtime.js";
import type { LocalCommand } from "../core/commands.js";
import { parseInput } from "../core/commands.js";
import { getActiveTab } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState, MixCodeTabInfo } from "../core/types.js";
import { submitAgentInput } from "./agent-tab-actions.js";
import { errorMessage } from "./app-overlays.js";
import { BATCH_COMMAND_HANDLERS } from "./app-submit-batch.js";
import { SESSION_COMMAND_HANDLERS } from "./app-submit-session.js";
import { SETTINGS_COMMAND_HANDLERS } from "./app-submit-settings.js";
import { UI_COMMAND_HANDLERS } from "./app-submit-ui.js";
import { WORKSPACE_COMMAND_HANDLERS } from "./app-submit-workspace.js";
import {
  type AuthInputHost,
  type LocalCommandHandler,
  type MixCodeEditorActions,
  type MixCodeSubmitRuntime,
  type OverlayTui,
  type SettingsPanelDependencies,
  SKIP_FINALIZE,
} from "./app-types.js";

export async function handleSubmittedInput(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  text: string,
  tui: OverlayTui,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  authInputHost?: AuthInputHost,
  workspaceFile?: string,
  /** When set (e.g. Home send), submit targets this tab without changing activeTabId. */
  activeTabOverride?: MixCodeTabInfo,
  /** Settings panel dependencies — required to open /settings overlay. */
  settingsDeps?: SettingsPanelDependencies,
  /** Input editor: restore text after a bash-already-running conflict; /editor reads and writes the draft. */
  editorActions?: Pick<MixCodeEditorActions, "setText"> &
    Partial<Pick<MixCodeEditorActions, "getText">>,
): Promise<void> {
  const parsed = parseInput(text);
  const active = activeTabOverride ?? getActiveTab(state);
  const requiresActive =
    parsed.kind !== "local-command" || !CONFIG_SCOPED_COMMANDS.has(parsed.command);
  if (!active && requiresActive) {
    throw new Error("Error: No agent to send to");
  }
  if (active?.status === "Not Ready" && requiresActive) {
    throw new Error("Tab is still loading extensions. Please wait a moment.");
  }
  try {
    if (active && (await submitAgentInput(active, runtime, text, parsed))) {
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
  } catch (error) {
    // Pi restores the editor and warns instead of dropping a concurrent !shell.
    if (isBashAlreadyRunningError(error)) {
      editorActions?.setText(text);
      const message = errorMessage(error);
      if (active && runtime.getTab(active.sessionId)) {
        runtime.appendSystemMessage(active.sessionId, message, "error");
      } else if (active) {
        pushToast(active, {
          type: "warning",
          message,
        });
      }
      await onStateChanged?.(state);
      tui.requestRender();
      return;
    }
    throw error;
  }
  if (parsed.kind === "local-command") {
    const result = await LOCAL_COMMAND_HANDLERS[parsed.command]({
      state,
      runtime,
      active,
      args: parsed.args,
      rawArgs: text
        .trimStart()
        .slice(parsed.command.length + 1)
        .trimStart(),
      tui,
      onStateChanged,
      authInputHost,
      workspaceFile,
      settingsDeps,
      editorActions,
    });
    if (result === SKIP_FINALIZE) return;
  }
  await onStateChanged?.(state);
  tui.requestRender();
}

const LOCAL_COMMAND_HANDLERS = {
  ...BATCH_COMMAND_HANDLERS,
  ...SESSION_COMMAND_HANDLERS,
  ...WORKSPACE_COMMAND_HANDLERS,
  ...SETTINGS_COMMAND_HANDLERS,
  ...UI_COMMAND_HANDLERS,
} satisfies Record<LocalCommand, LocalCommandHandler>;

const CONFIG_SCOPED_COMMANDS: ReadonlySet<LocalCommand> = new Set([
  "batch",
  "tui-state",
  "console-history",
  "new-session",
  "resume",
  "group-colored-tabs",
  "hide-thinking",
  "settings",
  "delete-all-sessions",
  "close-all-sessions",
  "save-workspace",
  "restore-workspace",
  "delete-workspace",
  "extension-manager",
  "vim",
  "toggle-zen-mode",
  "toggle-inline-widgets",
  "widgets",
  "login",
  "logout",
  "palette",
  "jump",
  "editor",
  "quit",
  "exit",
]);
