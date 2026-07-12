import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeKeyRuntime } from "./app-types.js";

export function findOpenSessionTab(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime | undefined,
  sessionPath: string,
): MixCodeState["tabs"][number] | undefined {
  if (!runtime?.getTab) return undefined;
  return state.tabs.find(
    (tab) => runtime.getTab?.(tab.sessionId)?.session.getSessionFile() === sessionPath,
  );
}

export async function deleteSessionFile(
  sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
  if (trashResult.status === 0 || !existsSync(sessionPath)) {
    return { ok: true, method: "trash" };
  }
  try {
    await unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (error) {
    return {
      ok: false,
      method: "unlink",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
