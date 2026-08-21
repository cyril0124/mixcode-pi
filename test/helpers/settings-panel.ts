import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { RawMixCodeSettings } from "../../src/core/mixcode-settings.js";
import type { MixCodeState } from "../../src/core/types.js";
import type { OverlayTui } from "../../src/ui/app-types.js";
import { SettingsPanel } from "../../src/ui/components/settings-panel.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const NOOP_TUI: OverlayTui = {
  requestRender: () => undefined,
  showOverlay: () => ({ hide: () => undefined }) as never,
};

/** Standalone settings panel for tests; drive handleInput, assert via render. */
export function createSettingsPanel(
  state: MixCodeState,
  settingsManager: SettingsManager,
  init?: {
    mixcodeRaw?: RawMixCodeSettings;
    mixcodeFile?: string;
    piSettingsFile?: string;
    tui?: OverlayTui;
    setHideThinkingBlock?: (hide: boolean) => Promise<void>;
    setShowCacheMissNotices?: (show: boolean) => Promise<void>;
  },
): SettingsPanel {
  return new SettingsPanel(
    {
      state,
      tui: init?.tui ?? NOOP_TUI,
      settingsManager,
      setHideThinkingBlock: init?.setHideThinkingBlock,
      setShowCacheMissNotices: init?.setShowCacheMissNotices,
    },
    {
      mixcodeRaw: init?.mixcodeRaw ?? {},
      mixcodeFile: init?.mixcodeFile ?? "/tmp/mixcode_settings.json",
      piSettingsFile: init?.piSettingsFile ?? "/tmp/settings.json",
    },
  );
}

export function selectSettingsItemByLabel(panel: SettingsPanel, label: string): void {
  for (let index = 0; ; index++) {
    panel.selectedIndex = index;
    const selected = stripAnsi(panel.render(120).join("\n"))
      .split("\n")
      .find((line) => line.includes("› "));
    if (selected?.includes(label)) return;
    if (!selected) throw new Error(`Unknown settings item: ${label}`);
  }
}
