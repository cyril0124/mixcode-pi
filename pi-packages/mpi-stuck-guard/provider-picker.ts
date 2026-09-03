import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";

export interface ProviderPickerOptions {
  tui: TUI;
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  providers: readonly string[];
  selected: readonly string[];
  done: (providers: string[]) => void;
}

export function createProviderPicker(options: ProviderPickerOptions) {
  let query = "";
  let selected = new Set(options.selected);
  let cursor = 0;

  function matches(): string[] {
    const normalized = query.trim().toLowerCase();
    return options.providers.filter((provider) => provider.toLowerCase().includes(normalized));
  }

  function finish(): void {
    options.done([...selected].sort());
  }

  return {
    handleInput(data: string): void {
      const visible = matches();
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        finish();
        return;
      }
      if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
      else if (matchesKey(data, Key.down))
        cursor = Math.min(Math.max(0, visible.length - 1), cursor + 1);
      else if (matchesKey(data, Key.enter)) {
        const provider = visible[cursor];
        if (provider) {
          if (selected.has(provider)) selected.delete(provider);
          else selected.add(provider);
        }
      } else if (matchesKey(data, Key.backspace)) {
        query = query.slice(0, -1);
        cursor = 0;
      } else if (data.length > 0 && data.charCodeAt(0) >= 0x20 && data !== "\x7f") {
        query += data;
        cursor = 0;
      } else return;
      options.tui.requestRender();
    },
    invalidate() {},
    render(width: number): string[] {
      const inner = Math.max(20, width - 4);
      const visible = matches();
      const lines = [
        options.theme.bold(options.theme.fg("accent", "Select Providers")),
        options.theme.fg("dim", `Search: ${query || "(all)"}`),
        "",
        ...visible.map((provider, index) => {
          const marker = index === cursor ? options.theme.fg("accent", "›") : " ";
          const checked = selected.has(provider)
            ? options.theme.fg("success", "[x]")
            : options.theme.fg("dim", "[ ]");
          return `${marker} ${checked} ${options.theme.fg(index === cursor ? "text" : "muted", provider)}`;
        }),
        visible.length === 0 ? options.theme.fg("dim", "No matching providers.") : "",
        options.theme.fg("dim", "Type to search · ↑/↓ navigate · Enter toggle · Esc save"),
      ];
      const container = new Container();
      const border = (text: string) => options.theme.fg("accent", text);
      container.addChild(new DynamicBorder(border));
      container.addChild(
        new Text(lines.map((line) => truncateToWidth(line, inner)).join("\n"), 1, 0),
      );
      container.addChild(new DynamicBorder(border));
      return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
    },
  };
}
