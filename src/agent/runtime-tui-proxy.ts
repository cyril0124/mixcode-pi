import type { Terminal, TUI as PiTui } from "@earendil-works/pi-tui";

export function createTerminalRowsProxy(tui: PiTui, getRows: () => number | undefined): PiTui {
  const terminal = new Proxy(tui.terminal, {
    get(target, property) {
      if (property === "rows") return normalizeRows(getRows(), target.rows);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as Terminal;

  return new Proxy(tui, {
    get(target, property) {
      if (property === "terminal") return terminal;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as PiTui;
}

function normalizeRows(rows: number | undefined, fallback: number): number {
  const value = rows ?? fallback;
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : fallback));
}
