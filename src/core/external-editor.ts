import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ExternalEditorOptions {
  editor?: string;
  tempRoot?: string;
}

export async function editTextInExternalEditor(
  initialText: string,
  options: ExternalEditorOptions = {},
): Promise<string> {
  const editor = options.editor ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) throw new Error("External editor is not configured; set VISUAL or EDITOR");
  const dir = await fs.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "mixcode-input-"));
  const filePath = path.join(dir, "input.md");
  try {
    await Bun.write(filePath, initialText);
    await runEditor(editor, filePath);
    return await Bun.file(filePath).text();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export type ExternalEditorProbe = (editor: string) => boolean;

export function resolveAvailableExternalEditor(
  preferred?: string,
  probe: ExternalEditorProbe = isExternalEditorAvailable,
): string | undefined {
  const explicit = preferred?.trim();
  if (explicit) return probe(explicit) ? explicit : undefined;
  return ["nvim", "vim"].find(probe);
}

export function isExternalEditorAvailable(editor?: string): boolean {
  const [command, ...args] = parseEditorCommand(
    editor ?? process.env.VISUAL ?? process.env.EDITOR ?? "",
  );
  if (!command) return false;
  const executable = resolveEditorExecutable(command);
  if (!executable) return false;
  const probe = Bun.spawnSync([executable, ...args, "--version"], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 1_000,
    killSignal: "SIGTERM",
  });
  return probe.exitCode === 0;
}

function resolveEditorExecutable(command: string): string | undefined {
  if (!(path.isAbsolute(command) || command.includes(path.sep))) {
    return Bun.which(command) ?? undefined;
  }
  try {
    if (!fsSync.statSync(command).isFile()) return undefined;
    fsSync.accessSync(command, fsSync.constants.X_OK);
    return command;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return undefined;
    throw error;
  }
}

async function runEditor(editor: string, filePath: string): Promise<void> {
  const [command, ...args] = parseEditorCommand(editor);
  if (!command) throw new Error("External editor command is empty");
  const child = Bun.spawn([command, ...args, filePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code === 0) return;
  // Prefer signal name when the process was killed (matches prior node:child_process contract).
  const reason = child.signalCode ?? code ?? "unknown";
  throw new Error(`External editor exited with ${reason}`);
}

function parseEditorCommand(editor: string): string[] {
  const trimmed = editor.trim();
  if (!trimmed) return [];
  // Sync interface: whole string is a path to an existing binary.
  if (fsSync.existsSync(trimmed)) return [trimmed];

  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    const next = trimmed[index + 1];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (quote === '"' && char === "\\" && next !== undefined) {
        current += next;
        index++;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      current += next;
      index++;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}
