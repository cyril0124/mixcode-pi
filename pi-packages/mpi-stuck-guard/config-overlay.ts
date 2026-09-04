import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Container,
  Text,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import type { StuckGuardConfig } from "./config.js";

export type ConfigKey = keyof StuckGuardConfig;

const SECTIONS: readonly { title: string; keys: readonly ConfigKey[] }[] = [
  { title: "General", keys: ["streamWatchdogEnabled", "providerIds"] },
  {
    title: "Provider stream watchdog",
    keys: [
      "streamStartTimeoutSeconds",
      "streamIdleTimeoutSeconds",
      "streamRetryStartTimeoutSeconds",
      "knownTimeoutCooldownSeconds",
    ],
  },
  { title: "Schema hint", keys: ["schemaHintFailureThreshold"] },
];

const CONFIG_KEYS: readonly ConfigKey[] = SECTIONS.flatMap((section) => section.keys);

const LABELS: Record<ConfigKey, string> = {
  streamWatchdogEnabled: "Stream watchdog",
  providerIds: "Provider IDs",
  streamStartTimeoutSeconds: "Stream start timeout (s)",
  streamIdleTimeoutSeconds: "Stream idle timeout (s)",
  streamRetryStartTimeoutSeconds: "Retry start timeout (s)",
  knownTimeoutCooldownSeconds: "Timeout cooldown (s)",
  schemaHintFailureThreshold: "Hint failure threshold",
};

const DESCRIPTIONS: Record<ConfigKey, string> = {
  streamWatchdogEnabled: "Abort stalled provider streams and hand the error to host retry.",
  providerIds: "Configured provider IDs to watch; empty means every configured provider.",
  streamStartTimeoutSeconds: "Maximum wait for the provider's first event; 0 disables.",
  streamIdleTimeoutSeconds: "Maximum gap between provider events; 0 disables.",
  streamRetryStartTimeoutSeconds:
    "First-event wait after a known timeout in this session; 0 disables.",
  knownTimeoutCooldownSeconds:
    "How long this session keeps the retry start window after a timeout.",
  schemaHintFailureThreshold:
    "Consecutive validation failures of the same tool before the schema hint fires.",
};

export interface StuckGuardConfigOverlayOptions {
  tui: TUI;
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  initial: StuckGuardConfig;
  configPath: string;
  input: (key: ConfigKey, current: unknown) => Promise<string | undefined>;
  persist: (config: StuckGuardConfig) => { ok: true } | { ok: false; error: string };
  onError: (message: string) => void;
  done: () => void;
}

export function createStuckGuardConfigOverlay(options: StuckGuardConfigOverlayOptions) {
  let config = { ...options.initial, providerIds: [...options.initial.providerIds] };
  let selected = 0;
  let editing = false;

  async function editSelected(): Promise<void> {
    if (editing) return;
    editing = true;
    try {
      const key = CONFIG_KEYS[selected]!;
      if (typeof config[key] === "boolean") {
        const next = { ...config, [key]: !config[key] };
        const result = options.persist(next);
        if (!result.ok) options.onError(result.error);
        else config = next;
        options.tui.requestRender();
        return;
      }
      const raw = await options.input(key, config[key]);
      if (raw === undefined) return;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        options.onError(
          `Error: invalid JSON value: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const next = { ...config, [key]: value };
      const result = options.persist(next);
      if (!result.ok) options.onError(result.error);
      else config = { ...next, providerIds: [...next.providerIds] };
      options.tui.requestRender();
    } finally {
      editing = false;
    }
  }

  return {
    handleInput(data: string): void {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
        options.done();
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") selected = Math.max(0, selected - 1);
      else if (matchesKey(data, Key.down) || data === "j")
        selected = Math.min(CONFIG_KEYS.length - 1, selected + 1);
      else if (matchesKey(data, Key.enter) || data === " ") void editSelected();
      else return;
      options.tui.requestRender();
    },
    invalidate() {},
    render(width: number): string[] {
      const inner = Math.max(20, width - 4);
      const lines = [
        options.theme.bold(options.theme.fg("accent", "Stuck Guard Configuration")),
        options.theme.fg("dim", truncateToWidth(options.configPath, inner)),
        "",
        ...SECTIONS.flatMap((section) => [
          options.theme.bold(options.theme.fg("accent", section.title)),
          ...section.keys.map((key) => {
            const index = CONFIG_KEYS.indexOf(key);
            const marker = index === selected ? options.theme.fg("accent", "›") : " ";
            const value = JSON.stringify(config[key]);
            return `${marker} ${options.theme.fg(index === selected ? "text" : "muted", LABELS[key])}: ${options.theme.fg("dim", value)}`;
          }),
        ]),
        "",
        options.theme.fg(
          "dim",
          truncateToWidth(`Info: ${DESCRIPTIONS[CONFIG_KEYS[selected]!]}`, inner),
        ),
        options.theme.fg("dim", "↑/↓ or j/k select · Enter edit · Esc/q close"),
      ];
      const borderColor = (text: string) => options.theme.fg("accent", text);
      const container = new Container();
      container.addChild(new DynamicBorder(borderColor));
      container.addChild(new Text(lines.join("\n"), 1, 0));
      container.addChild(new DynamicBorder(borderColor));
      return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
    },
  };
}
