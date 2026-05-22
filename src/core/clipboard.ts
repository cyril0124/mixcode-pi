import { spawn } from "node:child_process";

export type ClipboardWriter = (text: string) => Promise<void>;

export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) throw new Error("Cannot copy empty text selection.");
  const errors: string[] = [];
  try {
    await copyWithPbcopy(text);
    return;
  } catch (error) {
    errors.push(`pbcopy: ${errorMessage(error)}`);
  }
  try {
    copyWithOsc52(text);
    return;
  } catch (error) {
    errors.push(`OSC52: ${errorMessage(error)}`);
  }
  throw new Error(`Failed to copy selection to clipboard (${errors.join("; ")}).`);
}

export function copyWithOsc52(text: string, write?: (data: string) => void): void {
  if (!write && !process.stdout.isTTY) throw new Error("stdout is not a TTY");
  const target = write ?? process.stdout.write.bind(process.stdout);
  target(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}

export function copyWithPbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.on("error", reject);
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`));
    });
    child.stdin.end(text);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
