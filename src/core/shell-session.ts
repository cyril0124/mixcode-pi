import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EOL } from "node:os";
import type { MixCodeTabInfo, ShellSessionInfo } from "./types.js";
import type { SgrMouseInput } from "./mouse.js";

export class ShellManager {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  open(
    tab: MixCodeTabInfo,
    shell = process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "sh"),
  ): ShellSessionInfo {
    tab.shellOpen = true;
    tab.pendingEscapeAction = undefined;
    tab.pendingEscapeArmedAt = undefined;
    tab.shellScrollOffset = 0;
    if (tab.shellSession && this.processes.has(tab.sessionId)) return tab.shellSession;
    const child = spawn(shell, [], { cwd: tab.workdir, env: process.env });
    const session: ShellSessionInfo = {
      cwd: tab.workdir,
      pid: child.pid,
      command: shell,
      buffer: [`$ ${shell}`, `cwd: ${tab.workdir}`],
      input: "",
    };
    tab.shellSession = session;
    this.processes.set(tab.sessionId, child);
    child.stdout.on("data", (chunk: Buffer) => appendShellOutput(session, chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => appendShellOutput(session, chunk.toString("utf8")));
    child.on("error", (error) => appendShellOutput(session, `shell error: ${error.message}`));
    child.on("close", (code, signal) => {
      session.exitCode = code ?? undefined;
      session.signal = signal ?? undefined;
      this.processes.delete(tab.sessionId);
      appendShellOutput(session, `shell exited: ${code ?? signal ?? "unknown"}`);
    });
    return session;
  }

  write(tab: MixCodeTabInfo, data: string): boolean {
    const child = this.processes.get(tab.sessionId);
    if (!child || !tab.shellSession) return false;
    if (data === "\r") {
      tab.shellSession.buffer.push(`$ ${tab.shellSession.input}`);
      tab.shellSession.input = "";
      child.stdin.write(EOL);
      return true;
    }
    if (data === "\u0003") {
      child.stdin.write("\u0003");
      tab.shellSession.input = "";
      return true;
    }
    if (data === "\u007f" || data === "\b") {
      tab.shellSession.input = tab.shellSession.input.slice(0, -1);
      child.stdin.write(data);
      return true;
    }
    if (data.length === 1 && data >= " ") {
      tab.shellSession.input += data;
      child.stdin.write(data);
      return true;
    }
    child.stdin.write(data);
    return true;
  }

  writeMouse(tab: MixCodeTabInfo, mouse: SgrMouseInput): boolean {
    const session = tab.shellSession;
    if (!session) return false;
    if (session.sgrMouse) {
      return this.write(
        tab,
        `\x1b[<${mouse.button};${mouse.x};${mouse.y}${mouse.release ? "m" : "M"}`,
      );
    }
    if (session.alternateScreen && mouse.wheel) {
      return this.write(tab, mouse.wheel === "up" ? "\x1b[A" : "\x1b[B");
    }
    return false;
  }

  close(tab: MixCodeTabInfo): void {
    const child = this.processes.get(tab.sessionId);
    if (child) {
      child.kill();
      this.processes.delete(tab.sessionId);
    }
    tab.shellOpen = false;
    tab.pendingEscapeAction = undefined;
    tab.pendingEscapeArmedAt = undefined;
    tab.shellScrollOffset = 0;
  }

  isRunning(tab: MixCodeTabInfo): boolean {
    return this.processes.has(tab.sessionId);
  }
}

export function appendShellOutput(session: ShellSessionInfo, output: string, maxLines = 200): void {
  updateShellTerminalModes(session, output);
  const normalized = stripTerminalControls(output).replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return;
  session.buffer.push(...lines);
  if (session.buffer.length > maxLines) {
    session.buffer.splice(0, session.buffer.length - maxLines);
  }
}

function stripTerminalControls(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_].*?\x1b\\/gs, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function updateShellTerminalModes(session: ShellSessionInfo, output: string): void {
  for (const match of output.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    const enabled = match[2] === "h";
    for (const code of match[1]!.split(";")) {
      if (code === "1049" || code === "47" || code === "1047") session.alternateScreen = enabled;
      if (code === "1000") session.normalMouse = enabled;
      if (code === "1006") session.sgrMouse = enabled;
    }
  }
}
