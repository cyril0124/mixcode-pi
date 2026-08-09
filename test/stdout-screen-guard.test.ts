import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  installStdoutScreenGuard,
  stripUnauthorizedScreenClears,
  uninstallStdoutScreenGuard,
  withHostStdoutGuard,
  withHostStdoutWrite,
} from "../src/ui/stdout-screen-guard.js";

test("stripUnauthorizedScreenClears removes full-screen clear+home", () => {
  const { text, stripped } = stripUnauthorizedScreenClears("\x1b[2J\x1b[Hkeep");
  assert.equal(stripped, true);
  assert.equal(text, "keep");
});

test("stripUnauthorizedScreenClears removes scrollback clear", () => {
  const { text, stripped } = stripUnauthorizedScreenClears("pre\x1b[3Jpost");
  assert.equal(stripped, true);
  assert.equal(text, "prepost");
});

test("stripUnauthorizedScreenClears leaves bare cursor-home alone", () => {
  const { text, stripped } = stripUnauthorizedScreenClears("\x1b[Hhello");
  assert.equal(stripped, false);
  assert.equal(text, "\x1b[Hhello");
});

function withCapturedStdout(run: () => void | Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // Become the "real" write so installStdoutScreenGuard captures this as originalWrite.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    written.push(s);
    const cb =
      typeof rest[0] === "function" ? rest[0] : typeof rest[1] === "function" ? rest[1] : undefined;
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as typeof process.stdout.write;
  return Promise.resolve()
    .then(() => run())
    .finally(() => {
      uninstallStdoutScreenGuard();
      process.stdout.write = realWrite;
    })
    .then(() => written);
}

test("stdout guard blocks extension full-screen clear and coalesces repaint", async () => {
  let blocked = 0;
  const written = await withCapturedStdout(async () => {
    installStdoutScreenGuard({
      onBlockedClear: () => {
        blocked += 1;
      },
    });
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("visible");
    // Trailing 50ms debounce — wait past the coalesce window.
    await Bun.sleep(80);
  });
  assert.equal(
    written.join(""),
    "visible",
    "full-screen clears must not reach the wire without host depth",
  );
  assert.equal(blocked, 1, "N clears in one storm coalesce to one repaint");
});

test("host-depth writes may still clear the screen", async () => {
  const written = await withCapturedStdout(() => {
    installStdoutScreenGuard({});
    withHostStdoutWrite(() => {
      process.stdout.write("\x1b[2J\x1b[H");
    });
  });
  assert.equal(written.join(""), "\x1b[2J\x1b[H");
});

test("withHostStdoutGuard marks terminal.clearScreen as host write", async () => {
  const written = await withCapturedStdout(() => {
    installStdoutScreenGuard({});
    const inner = {
      start: () => undefined,
      stop: () => undefined,
      drainInput: async () => undefined,
      write: (data: string) => {
        process.stdout.write(data);
      },
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      moveBy: () => undefined,
      hideCursor: () => undefined,
      showCursor: () => undefined,
      clearLine: () => undefined,
      clearFromCursor: () => undefined,
      clearScreen: () => {
        process.stdout.write("\x1b[2J\x1b[H");
      },
      setTitle: () => undefined,
      setProgress: () => undefined,
    } as Terminal;
    withHostStdoutGuard(inner).clearScreen();
  });
  assert.equal(written.join(""), "\x1b[2J\x1b[H");
});
