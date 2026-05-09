import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "mixcode-input-"));
  const filePath = join(dir, "input.md");
  try {
    await writeFile(filePath, initialText, "utf8");
    await runEditor(editor, filePath);
    return await readFile(filePath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runEditor(editor: string, filePath: string): Promise<void> {
  const [command, ...args] = editor.split(/\s+/).filter(Boolean);
  if (!command) throw new Error("External editor command is empty");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`External editor exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}
