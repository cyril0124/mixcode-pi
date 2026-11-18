import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const pickerOptions = [
  "--no-multi",
  "--print0",
  "--layout=reverse",
  "--border=rounded",
  "--margin=0,1",
  "--prompt=Find file › ",
  "--pointer=▸",
  "--header=Enter to insert · Esc to cancel",
  "--color=prompt:6,pointer:6,hl:6,hl+:6:bold,fg+:bold",
];

function pickFile(cwd: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("fzf", pickerOptions, {
      cwd,
      stdio: ["inherit", "pipe", "inherit"],
      // Use fzf's file walker and keep stdout limited to one NUL-terminated path.
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
      if (code === 0) resolve(output.replace(/\0$/, ""));
      else if (code === 1 || code === 130 || signal === "SIGINT") resolve(undefined);
      else reject(new Error(`fzf exited with ${signal ?? code}`));
    });
  });
}

async function appendFile(ctx: ExtensionCommandContext): Promise<void> {
  const path = await ctx.ui.custom<string | undefined>(async (tui, _theme, _keys, done) => {
    tui.stop();
    try {
      done(await pickFile(ctx.cwd));
    } finally {
      tui.start();
      tui.requestRender(true);
    }
    return { render: () => [], invalidate: () => {} };
  });
  if (path) ctx.ui.setEditorText(ctx.ui.getEditorText() + path);
}

export default function fzfExtension(pi: ExtensionAPI): void {
  pi.registerCommand("fzf", {
    description: "Pick a file and append its path to the draft",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/fzf requires an interactive terminal");
      // The command palette restores its draft after the handler returns.
      setImmediate(() => {
        void appendFile(ctx).catch((error: Error) => ctx.ui.notify(error.message, "error"));
      });
    },
  });
}
