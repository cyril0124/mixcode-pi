import type { MixCodeRuntime } from "../agent/runtime.js";
import type { OverlayTui } from "./app-types.js";

export const DEFAULT_QUIT_EXIT_TIMEOUT_MS = 1_500;

export type QuitExitScheduler = (code: number) => void;

export interface QuitOptions {
  exitProcess?: boolean;
  exitScheduler?: QuitExitScheduler;
  exitTimeoutMs?: number;
}

export type QuitConfiguredTui = OverlayTui & {
  mixCodeExitProcessOnQuit?: boolean;
};

export type RuntimeQuitTarget = Partial<
  Pick<MixCodeRuntime, "abortAllTabs" | "beginShutdown" | "closeAllTabs">
>;

export async function shutdownRuntimeAndStopTui(
  runtime: RuntimeQuitTarget | undefined,
  tui: OverlayTui,
): Promise<void> {
  if (!tui.stop) throw new Error("Quit command requires TUI stop support");
  runtime?.beginShutdown?.();
  runtime?.abortAllTabs?.();
  tui.stop();
  if (runtime?.closeAllTabs) await runtime.closeAllTabs();
}

export function getConfiguredQuitOptions(tui: OverlayTui): QuitOptions {
  return { exitProcess: (tui as QuitConfiguredTui).mixCodeExitProcessOnQuit === true };
}

export async function quitMixCode(
  runtime: RuntimeQuitTarget | undefined,
  tui: OverlayTui,
  options: QuitOptions = {},
): Promise<void> {
  const exitProcess = options.exitProcess === true;
  let exitTimer: NodeJS.Timeout | undefined;
  if (exitProcess) {
    const exitScheduler = options.exitScheduler ?? ((code: number) => process.exit(code));
    // CLI quit owns the process lifetime. Once the terminal is restored, shutdown
    // handlers are best-effort; this explicit watchdog prevents a stale extension
    // timer, child process, or network check from keeping the shell blocked.
    exitTimer = setTimeout(
      () => exitScheduler(0),
      options.exitTimeoutMs ?? DEFAULT_QUIT_EXIT_TIMEOUT_MS,
    );
    exitTimer.unref?.();
  }

  try {
    await shutdownRuntimeAndStopTui(runtime, tui);
  } finally {
    if (exitTimer) clearTimeout(exitTimer);
  }

  tui.requestRender();

  if (exitProcess) {
    const exitScheduler = options.exitScheduler ?? ((code: number) => process.exit(code));
    exitScheduler(0);
  }
}
