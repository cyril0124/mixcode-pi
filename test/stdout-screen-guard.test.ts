import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { installStdoutScreenGuard, withHostStdoutGuard } from "../src/ui/stdout-screen-guard.js";

async function withCapturedStdout(
  run: (install: typeof installStdoutScreenGuard) => void | Promise<void>,
): Promise<string[]> {
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  let dispose: (() => void) | undefined;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    written.push(text);
    const callback =
      typeof rest[0] === "function" ? rest[0] : typeof rest[1] === "function" ? rest[1] : undefined;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;
  const install = () => {
    dispose = installStdoutScreenGuard();
    return dispose;
  };
  try {
    await run(install);
  } finally {
    dispose?.();
    process.stdout.write = realWrite;
  }
  return written;
}

test("stdout guard removes full-screen clear+home", async () => {
  const written = await withCapturedStdout((install) => {
    install();
    process.stdout.write("\x1b[2J\x1b[Hkeep");
  });
  assert.equal(written.join(""), "keep");
});

test("stdout guard removes scrollback clear", async () => {
  const written = await withCapturedStdout((install) => {
    install();
    process.stdout.write("pre\x1b[3Jpost");
  });
  assert.equal(written.join(""), "prepost");
});

test("stdout guard leaves bare cursor-home alone", async () => {
  const written = await withCapturedStdout((install) => {
    install();
    process.stdout.write("\x1b[Hhello");
  });
  assert.equal(written.join(""), "\x1b[Hhello");
});

test("stdout guard writes nothing for clears that leave an empty chunk", async () => {
  const written = await withCapturedStdout((install) => {
    install();
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("visible");
  });
  assert.equal(written.join(""), "visible");
});

test("withHostStdoutGuard marks terminal.clearScreen as host write", async () => {
  const written = await withCapturedStdout((install) => {
    install();
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
