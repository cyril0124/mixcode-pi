import { isBashAlreadyRunningError } from "../agent/runtime.js";
import { isLocalCommand, type LocalCommand, parseInput } from "../core/commands.js";
import { getActiveTab } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState, MixCodeTabInfo } from "../core/types.js";
import { submitAgentInput } from "./agent-tab-actions.js";
import { appendActiveSystemMessage } from "./app-actions.js";
import { errorMessage } from "./app-overlays.js";
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

export { renderSessionInfoText } from "./app-submit-session.js";

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
  /** Optional editor restore hook for Pi-parity bash-already-running conflicts. */
  editorActions?: Pick<MixCodeEditorActions, "setText">,
): Promise<void> {
  const parsed = parseInput(text);
  const active = activeTabOverride ?? getActiveTab(state);
  const requiresActive =
    parsed.kind === "prompt" || parsed.kind === "shell" || !configScopedCommand(parsed.command);
  if (!active && requiresActive) return;
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
  if (isLocalCommand(parsed.command)) {
    const result = await LOCAL_COMMAND_HANDLERS[parsed.command]({
      state,
      runtime,
      active,
      args: parsed.args,
      tui,
      onStateChanged,
      authInputHost,
      workspaceFile,
      settingsDeps,
    });
    if (result === SKIP_FINALIZE) return;
  } else {
    appendActiveSystemMessage(state, runtime, `Unknown slash command: /${parsed.command}`.trim());
  }
  await onStateChanged?.(state);
  tui.requestRender();
}

const LOCAL_COMMAND_HANDLERS = {
  ...SESSION_COMMAND_HANDLERS,
  ...WORKSPACE_COMMAND_HANDLERS,
  ...SETTINGS_COMMAND_HANDLERS,
  ...UI_COMMAND_HANDLERS,
} satisfies Record<LocalCommand, LocalCommandHandler>;

const CONFIG_SCOPED_COMMANDS: ReadonlySet<LocalCommand> = new Set([
  "tui-state",
  "new-session",
  "resume",
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
  "login",
  "logout",
  "quit",
  "exit",
]);

function configScopedCommand(command: string | undefined): boolean {
  return isLocalCommand(command) && CONFIG_SCOPED_COMMANDS.has(command);
}
