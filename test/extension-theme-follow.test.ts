import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "./helpers/mixcode.js";
import {
  getActiveExtensionThemeId,
  noteActiveExtensionThemeId,
} from "../src/agent/runtime-extension-theme.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

test("extension footer rebuilds with current theme after noteActiveExtensionThemeId", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-ext-theme-follow-"));
  let factoryBuilds = 0;

  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setFooter((_tui, theme) => {
        factoryBuilds += 1;
        return {
          render: () => [`theme-name=${theme.name ?? "?"}`],
          invalidate: () => undefined,
        };
      });
    });
  };

  try {
    noteActiveExtensionThemeId("mixcode-dark");
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
    });

    assert.ok(runtimeTab.tab.extensionUi.footer);
    const first = stripAnsi(
      (
        runtimeTab.tab.extensionUi.footer?.render?.(80) ?? runtimeTab.tab.extensionUi.footer!.lines
      ).join("\n"),
    );
    assert.match(first, /theme-name=/);
    const buildsAfterFirst = factoryBuilds;

    noteActiveExtensionThemeId("tokyo-night");
    assert.equal(getActiveExtensionThemeId(), "tokyo-night");
    const second = stripAnsi((runtimeTab.tab.extensionUi.footer?.render?.(80) ?? []).join("\n"));
    assert.ok(
      factoryBuilds > buildsAfterFirst,
      "footer factory should rebuild when active extension theme id changes",
    );
    assert.match(second, /theme-name=/);
    // Tokyo-night extension theme uses a distinct Theme.name when mapped.
    // At minimum rebuild proves we no longer freeze the first factory theme forever.
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("message renderer receives updated theme after noteActiveExtensionThemeId", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-ext-theme-msg-"));
  const names: string[] = [];

  const extension: ExtensionFactory = (pi) => {
    pi.registerMessageRenderer("theme-probe", (_message, _opts, theme) => {
      names.push(theme.name ?? "unnamed");
      return {
        render: () => [`probe:${theme.name ?? "?"}`],
        invalidate: () => undefined,
      };
    });
    pi.registerCommand("theme-probe", {
      description: "emit theme probe message",
      handler: async () => {
        pi.sendMessage({ customType: "theme-probe", content: "x", display: true });
      },
    });
  };

  try {
    noteActiveExtensionThemeId("mixcode-dark");
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "/theme-probe");
    const line = runtimeTab.chat.find((l) => l.customType === "theme-probe");
    assert.ok(line?.renderExtension);
    line!.renderExtension!(80);
    const afterDark = names.at(-1);

    noteActiveExtensionThemeId("tokyo-night");
    // Theme id is part of the component cache key — no manual cache clear needed.
    line!.renderExtension!(80);
    const afterTokyo = names.at(-1);

    assert.notEqual(
      afterDark,
      afterTokyo,
      "renderer theme should follow active extension theme id",
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
