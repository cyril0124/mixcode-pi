import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Container,
  Text,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import type { DoomLoopConfig, StuckGuardConfig } from "./config.js";

/**
 * One editable row of the configuration page. `kind` decides how Enter edits:
 * toggle/cycle persist immediately without a dialog; number/picker ask for JSON
 * input (picker opens the provider multi-select); text edits a raw string where
 * an empty answer clears the value. Parsed input is revalidated by `persist`.
 */
type ConfigRow =
  | {
      id: string;
      label: string;
      description: string;
      kind: "toggle";
      read: (config: StuckGuardConfig) => boolean;
      apply: (config: StuckGuardConfig, value: boolean) => StuckGuardConfig;
    }
  | {
      id: string;
      label: string;
      description: string;
      kind: "cycle";
      values: readonly string[];
      read: (config: StuckGuardConfig) => string;
      apply: (config: StuckGuardConfig, value: string) => StuckGuardConfig;
    }
  | {
      id: string;
      label: string;
      description: string;
      kind: "number";
      read: (config: StuckGuardConfig) => number;
      apply: (config: StuckGuardConfig, value: number) => StuckGuardConfig;
    }
  | {
      id: string;
      label: string;
      description: string;
      kind: "picker";
      read: (config: StuckGuardConfig) => string[];
      apply: (config: StuckGuardConfig, value: string[]) => StuckGuardConfig;
    }
  | {
      id: string;
      label: string;
      description: string;
      kind: "text";
      read: (config: StuckGuardConfig) => string;
      apply: (config: StuckGuardConfig, value: string) => StuckGuardConfig;
    };

const SECTIONS: readonly { title: string; rows: readonly ConfigRow[] }[] = [
  {
    title: "General",
    rows: [
      {
        id: "streamWatchdogEnabled",
        label: "Stream watchdog",
        description: "Abort stalled provider streams and hand the error to host retry.",
        kind: "toggle",
        read: (config) => config.streamWatchdogEnabled,
        apply: (config, value) => ({ ...config, streamWatchdogEnabled: value }),
      },
      {
        id: "providerIds",
        label: "Provider IDs",
        description: "Configured provider IDs to watch; empty means every configured provider.",
        kind: "picker",
        read: (config) => config.providerIds,
        apply: (config, value) => ({ ...config, providerIds: [...value] }),
      },
    ],
  },
  {
    title: "Provider stream watchdog",
    rows: [
      {
        id: "streamStartTimeoutSeconds",
        label: "Stream start timeout (s)",
        description: "Maximum wait for the provider's first event; 0 disables.",
        kind: "number",
        read: (config) => config.streamStartTimeoutSeconds,
        apply: (config, value) => ({ ...config, streamStartTimeoutSeconds: value }),
      },
      {
        id: "streamIdleTimeoutSeconds",
        label: "Stream idle timeout (s)",
        description: "Maximum gap between provider events; 0 disables.",
        kind: "number",
        read: (config) => config.streamIdleTimeoutSeconds,
        apply: (config, value) => ({ ...config, streamIdleTimeoutSeconds: value }),
      },
      {
        id: "streamRetryStartTimeoutSeconds",
        label: "Retry start timeout (s)",
        description: "First-event wait after a known timeout in this session; 0 disables.",
        kind: "number",
        read: (config) => config.streamRetryStartTimeoutSeconds,
        apply: (config, value) => ({ ...config, streamRetryStartTimeoutSeconds: value }),
      },
      {
        id: "knownTimeoutCooldownSeconds",
        label: "Timeout cooldown (s)",
        description: "How long this session keeps the retry start window after a timeout.",
        kind: "number",
        read: (config) => config.knownTimeoutCooldownSeconds,
        apply: (config, value) => ({ ...config, knownTimeoutCooldownSeconds: value }),
      },
    ],
  },
  {
    title: "Doom loop",
    rows: [
      {
        id: "doomLoop.action",
        label: "Doom loop action",
        description: "What happens on the third identical consecutive call; allow disables.",
        kind: "cycle",
        values: ["allow", "ask", "deny"],
        read: (config) => config.doomLoop.action,
        // The values list covers every action; persist revalidates regardless.
        apply: (config, value) => ({
          ...config,
          doomLoop: { ...config.doomLoop, action: value as DoomLoopConfig["action"] },
        }),
      },
      {
        id: "doomLoop.message",
        label: "Doom loop message",
        description: "Extra text appended to an automatic deny; an empty answer removes it.",
        kind: "text",
        read: (config) => config.doomLoop.message ?? "",
        apply: (config, value) => ({
          ...config,
          doomLoop:
            value === ""
              ? { action: config.doomLoop.action }
              : { ...config.doomLoop, message: value },
        }),
      },
    ],
  },
  {
    title: "Schema hint",
    rows: [
      {
        id: "schemaHintFailureThreshold",
        label: "Hint failure threshold",
        description:
          "Consecutive validation failures of the same tool before the schema hint fires.",
        kind: "number",
        read: (config) => config.schemaHintFailureThreshold,
        apply: (config, value) => ({ ...config, schemaHintFailureThreshold: value }),
      },
    ],
  },
];

const ROWS: readonly ConfigRow[] = SECTIONS.flatMap((section) => section.rows);

/** Text shown after the label; unset optional strings render as (unset). */
function displayValue(row: ConfigRow, config: StuckGuardConfig): string {
  const value = row.read(config);
  return row.kind === "text" && value === "" ? "(unset)" : JSON.stringify(value);
}

export interface StuckGuardConfigOverlayOptions {
  tui: TUI;
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  initial: StuckGuardConfig;
  configPath: string;
  /** Ask for one input line; prefill is JSON for number/picker rows, raw text otherwise. */
  input: (row: { id: string; label: string }, prefill: string) => Promise<string | undefined>;
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
      const row = ROWS[selected]!;
      let next: StuckGuardConfig;
      if (row.kind === "toggle") {
        next = row.apply(config, !row.read(config));
      } else if (row.kind === "cycle") {
        const index = row.values.indexOf(row.read(config));
        next = row.apply(config, row.values[(index + 1) % row.values.length]!);
      } else {
        const prefill = row.kind === "text" ? row.read(config) : JSON.stringify(row.read(config));
        const raw = await options.input(row, prefill);
        if (raw === undefined) return;
        if (row.kind === "text") {
          next = row.apply(config, raw);
        } else {
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch (error) {
            options.onError(
              `Error: invalid JSON value: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
          // Runtime shape is revalidated by persist via parseStuckGuardConfig.
          next =
            row.kind === "number"
              ? row.apply(config, value as number)
              : row.apply(config, value as string[]);
        }
      }
      const result = options.persist(next);
      if (!result.ok) options.onError(result.error);
      else {
        config = { ...next, providerIds: [...next.providerIds] };
        options.tui.requestRender();
      }
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
        selected = Math.min(ROWS.length - 1, selected + 1);
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
          ...section.rows.map((row) => {
            const index = ROWS.indexOf(row);
            const marker = index === selected ? options.theme.fg("accent", "›") : " ";
            return `${marker} ${options.theme.fg(index === selected ? "text" : "muted", row.label)}: ${options.theme.fg("dim", displayValue(row, config))}`;
          }),
        ]),
        "",
        options.theme.fg("dim", truncateToWidth(`Info: ${ROWS[selected]!.description}`, inner)),
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
