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
