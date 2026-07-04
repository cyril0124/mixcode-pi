import { spawn } from "node:child_process";

export type ClipboardWriter = (text: string) => Promise<void>;

const MAX_OSC52_BYTES = 100_000;

export async function copyTextToClipboard(text: string): Promise<void> {
  if (text == null) throw new Error("Cannot copy null/undefined to clipboard.");

  // ponytail: platform-aware strategy order, no trial on wrong OS
  const strategies = getClipboardStrategies();
  const errors: string[] = [];

  for (const strategy of strategies) {
    try {
      await strategy(text);
      return;
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  throw new Error(
    `Clipboard unavailable. Install xclip/wl-copy (Linux) or use OSC52-enabled terminal. Tried: ${errors.join("; ")}`
  );
}

function getClipboardStrategies(): Array<(text: string) => Promise<void>> {
  if (process.platform === "darwin") return [copyWithPbcopy, copyWithOsc52Async];
  if (process.platform === "win32") return [copyWithClip, copyWithOsc52Async];
  // Linux: Wayland first, then X11, then OSC52
  if (process.env.WAYLAND_DISPLAY) return [copyWithWlCopy, copyWithXclip, copyWithOsc52Async];
  return [copyWithXclip, copyWithWlCopy, copyWithOsc52Async];
}

export function copyWithOsc52(text: string, write?: (data: string) => void): void {
  if (!write && !process.stdout.isTTY) throw new Error("stdout is not a TTY");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_OSC52_BYTES) {
    throw new Error(`Text too large for OSC52 (${bytes.length} > ${MAX_OSC52_BYTES} bytes)`);
  }
  const target = write ?? process.stdout.write.bind(process.stdout);
  target(`\x1b]52;c;${bytes.toString("base64")}\x07`);
}

async function copyWithOsc52Async(text: string): Promise<void> {
  copyWithOsc52(text);
}

export function copyWithPbcopy(text: string): Promise<void> {
  return spawnCopyCommand("pbcopy", [], text);
}

function copyWithClip(text: string): Promise<void> {
  return spawnCopyCommand("clip", [], text);
}

function copyWithXclip(text: string): Promise<void> {
  return spawnCopyCommand("xclip", ["-selection", "clipboard"], text);
}

function copyWithWlCopy(text: string): Promise<void> {
  return spawnCopyCommand("wl-copy", [], text);
}

function spawnCopyCommand(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 5000, // ponytail: prevent hang
    });
    const stderr: Buffer[] = [];
    child.on("error", reject);
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const msg = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(msg || `${cmd} exit ${code}`));
    });
    child.stdin.end(text);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
