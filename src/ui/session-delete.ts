import * as path from "node:path";
import { invalidateSessionCatalog } from "../core/session-catalog.js";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeKeyRuntime } from "./app-types.js";

export function findOpenSessionTab(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime | undefined,
  sessionPath: string,
): MixCodeState["tabs"][number] | undefined {
  if (!runtime) return undefined;
  return state.tabs.find(
    (tab) => runtime.getTab(tab.sessionId)?.session.getSessionFile() === sessionPath,
  );
}

export async function deleteSessionFile(
  sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  let trashOk = false;
  try {
    // Bun.spawnSync throws when the binary is missing; node spawnSync returned status=null.
    const trashResult = Bun.spawnSync(["trash", ...trashArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });
    trashOk = trashResult.exitCode === 0;
  } catch {
    trashOk = false;
  }
  if (trashOk || !(await Bun.file(sessionPath).exists())) {
    invalidateSessionCatalog(path.dirname(sessionPath));
    return { ok: true, method: "trash" };
  }
  try {
    await Bun.file(sessionPath).unlink();
    invalidateSessionCatalog(path.dirname(sessionPath));
    return { ok: true, method: "unlink" };
  } catch (error) {
    return {
      ok: false,
      method: "unlink",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
