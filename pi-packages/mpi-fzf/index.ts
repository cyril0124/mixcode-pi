import { spawn } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, EditorComponent } from "@earendil-works/pi-tui";

const pickerOptions = [
  "--no-multi",
  "--print0",
  "--layout=reverse",
  "--border=rounded",
  "--margin=0,1",
  "--prompt=Find file › ",
  "--pointer=▸",
  "--expect=alt-up",
  "--header-first",
  "--color=prompt:6,pointer:6,hl:6,hl+:6:bold,fg+:bold",
];

function pickFile(cwd: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const header = `Directory: ${cwd}\nAlt+↑ parent directory · Enter to insert · Esc to cancel`;
    const child = spawn("fzf", [...pickerOptions, "--header", header], {
      cwd,
      stdio: ["inherit", "pipe", "inherit"],
      // Keep stdout limited to the exit key and file path, both NUL-delimited.
      env: {
        ...process.env,
        FZF_DEFAULT_COMMAND: "",
        FZF_DEFAULT_OPTS: "",
        FZF_DEFAULT_OPTS_FILE: "",
      },
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const [key, file] = output.split("\0", 2);
      if (key === "alt-up" && (code === 0 || code === 1)) resolve("..");
      else if (code === 0) resolve(file);
      else if (code === 1 || code === 130 || signal === "SIGINT") resolve(undefined);
      else reject(new Error(`fzf exited with ${signal ?? code}`));
    });
  });
}

async function insertFile(ctx: ExtensionCommandContext): Promise<void> {
  let insertAtCursor: ((text: string) => void) | undefined;
  const path = await ctx.ui.custom<string | undefined>(async (tui, _theme, _keys, done) => {
    if ("getFocusedComponent" in tui && typeof tui.getFocusedComponent === "function") {
      const focused: Component | null = tui.getFocusedComponent();
      if (
        focused &&
        "insertTextAtCursor" in focused &&
        typeof focused.insertTextAtCursor === "function"
      ) {
        insertAtCursor = focused.insertTextAtCursor.bind(focused);
      }
    }
    tui.stop();
    try {
      let directory = ctx.cwd;
      while (true) {
        const selected = await pickFile(directory);
        if (selected !== "..") {
          done(selected && relative(ctx.cwd, resolve(directory, selected)));
          break;
        }
        directory = dirname(directory);
      }
    } finally {
      tui.start();
      tui.requestRender(true);
    }
    return { render: () => [], invalidate: () => {} };
  });
  if (!path) return;
  if (insertAtCursor) insertAtCursor(path);
  else ctx.ui.pasteToEditor(path);
}

// The palette submits /fzf separately. Its temporary setText calls would reset the cursor.
function preservePaletteDraft(editor: EditorComponent): void {
  const originalSetText = editor.setText;
  const hadOwnMethod = Object.hasOwn(editor, "setText");
  const restore = () => {
    if (editor.setText !== guardedSetText) return;
    if (hadOwnMethod) editor.setText = originalSetText;
    else Reflect.deleteProperty(editor, "setText");
  };
  let fzfSelected = false;
  function guardedSetText(text: string): void {
    if (text === "/fzf") {
      fzfSelected = true;
      setImmediate(restore);
      return;
    }
    if (fzfSelected && text === editor.getText()) return;
    restore();
    originalSetText.call(editor, text);
  }
  editor.setText = guardedSetText;
  queueMicrotask(() => {
    if (!fzfSelected) restore();
  });
}

export default function fzfExtension(pi: ExtensionAPI): void {
  let detach: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    detach?.();
    await ctx.ui.custom<void>((tui, _theme, keys, done) => {
      if (!("getFocusedComponent" in tui) || typeof tui.getFocusedComponent !== "function") {
        done();
        return { render: () => [], invalidate: () => {} };
      }
      const focused = tui.getFocusedComponent.bind(tui) as () => Component | null;
      let editor: EditorComponent | undefined;
      detach = ctx.ui.onTerminalInput((data): undefined => {
        const focus = focused();
        if (editor === focus) editor = undefined;
        if (keys.matches(data, "app.palette")) {
          if (focus && "setText" in focus && "getText" in focus) editor = focus as EditorComponent;
          return;
        }
        if (!editor || !focus) return;

        preservePaletteDraft(editor);
      });
      done();
      return { render: () => [], invalidate: () => {} };
    });
  });
  pi.on("session_shutdown", () => detach?.());

  pi.registerCommand("fzf", {
    description: "Pick a file and insert its path at the cursor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/fzf requires an interactive terminal");
      // The command palette restores its draft after the handler returns.
      setImmediate(() => {
        void insertFile(ctx).catch((error: Error) => ctx.ui.notify(error.message, "error"));
      });
    },
  });
}
