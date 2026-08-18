// +----------------------------------------------------------------------+
// |  command-browser extension                                            |
// |  Registers /commands --> opens grouped overlay --> fills editor        |
// +----------------------------------------------------------------------+
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCommandBrowserComponent } from "./command-browser.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("commands", {
    description: "Browse all registered commands by category",
    handler: async (_args, ctx) => {
      const commands = pi.getCommands();
      if (!commands || commands.length === 0) {
        ctx.ui.notify("No extension/skill/prompt commands registered.", "info");
        return;
      }
      const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) =>
        createCommandBrowserComponent({ tui, theme, commands, done }),
      );
      if (selected) {
        ctx.ui.setEditorText(`/${selected} `);
      }
    },
  });
}
