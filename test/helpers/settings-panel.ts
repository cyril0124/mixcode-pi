import type { MixCodeState } from "../../src/core/types.js";
import { renderSettingsPanel } from "../../src/ui/settings-panel.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function selectSettingsItemByLabel(state: MixCodeState, label: string): void {
  const panel = state.settingsPanel;
  for (let index = 0; ; index++) {
    panel.selectedIndex = index;
    const selected = stripAnsi(renderSettingsPanel(state, 120).join("\n"))
      .split("\n")
      .find((line) => line.includes("› "));
    if (selected?.includes(label)) return;
    if (!selected) throw new Error(`Unknown settings item: ${label}`);
  }
}
