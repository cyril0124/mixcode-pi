import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { readSessionCatalog, writeSessionCatalog } from "../src/core/session-catalog-stream.js";

function session(id: string, text = '中文\nquoted "text"\\path'): SessionInfo {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/repo",
    name: `会话 ${id}`,
    parentSessionPath: "/sessions/parent.jsonl",
    created: new Date("2026-09-01T00:00:00.000Z"),
    modified: new Date("2026-09-02T00:00:00.000Z"),
    messageCount: 4,
    firstMessage: text,
    allMessagesText: `${text} assistant response`,
  };
}

function streamChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function wire(sessions: SessionInfo[]): Uint8Array {
  return Buffer.from(
    sessions
      .map((item) => JSON.stringify({ type: "session", session: item }))
      .concat(JSON.stringify({ type: "done", count: sessions.length }))
      .join("\n") + "\n",
  );
}

test("catalog frames survive every byte split including UTF-8 and escaped newlines", async () => {
  const expected = [session("one"), session("two")];
  const bytes = wire(expected);
  for (let split = 0; split <= bytes.length; split++) {
    const result = await readSessionCatalog(
      streamChunks([bytes.subarray(0, split), bytes.subarray(split)]),
    );
    assert.deepEqual(result, expected, `split=${split}`);
  }
  const singleBytes = [...bytes].map((byte) => Uint8Array.of(byte));
  assert.deepEqual(await readSessionCatalog(streamChunks(singleBytes)), expected);
});

test("catalog accepts empty results and preserves large complete search text", async () => {
  assert.deepEqual(await readSessionCatalog(streamChunks([wire([])])), []);
  const expected = [session("large", "中文\\\n".repeat(500_000))];
  const bytes = wire(expected);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4093)
    chunks.push(bytes.subarray(offset, offset + 4093));
  assert.deepEqual(await readSessionCatalog(streamChunks(chunks)), expected);
});

test("catalog yields to timers while consuming many frames already buffered in one read", async () => {
  const expected = Array.from({ length: 1200 }, (_, index) =>
    session(String(index), "search".repeat(6000)),
  );
  const bytes = wire(expected);
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 0);
  try {
    const result = await readSessionCatalog(streamChunks([bytes]));
    assert.equal(
      timerRan,
      true,
      "large catalog must allow other event-loop work before completion",
    );
    assert.deepEqual(result, expected);
  } finally {
    clearTimeout(timer);
  }
});

test("catalog rejects incomplete, inconsistent and malformed protocol output", async () => {
  const frame = `${JSON.stringify({ type: "session", session: session("one") })}\n`;
  for (const [text, message] of [
    ["", "missing completion"],
    [frame, "missing completion"],
    [frame + '{"type":"done","count":2}\n', "count mismatch"],
    [frame + '{"type":"done","count":1}', "truncated frame"],
    ['{"type":"done","count":0}\n{}\n', "data after completion"],
    ['{"type":"done","count":-1}\n', "invalid completion count"],
    [frame + "{bad}\n", "invalid JSONL frame"],
    ['{"type":"session","session":{"id":"broken"}}\n', "invalid session frame"],
    ['{"type":"unexpected"}\n', "invalid session frame"],
  ]) {
    await assert.rejects(
      readSessionCatalog(streamChunks([Buffer.from(text!)])),
      new RegExp(message!),
    );
  }
});

test("catalog waits for EOF even after the counted completion frame", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  let returned = false;
  const result = readSessionCatalog(stream).then((value) => {
    returned = true;
    return value;
  });
  controller.enqueue(wire([]));
  await Bun.sleep(5);
  assert.equal(returned, false);
  controller.close();
  assert.deepEqual(await result, []);
  assert.equal(stream.locked, false);
});

test("catalog cancellation interrupts a pending read and releases the pipe", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const abort = new AbortController();
  const result = readSessionCatalog(stream, abort.signal);
  abort.abort();
  await assert.rejects(result, { name: "AbortError", message: "Session listing cancelled" });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("catalog protocol errors cancel an open pipe instead of waiting for its producer", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("{bad}\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readSessionCatalog(stream), /invalid JSONL/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("catalog propagates stream read failures and releases the reader", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("pipe failed"));
    },
  });
  await assert.rejects(readSessionCatalog(stream), /pipe failed/);
  assert.equal(stream.locked, false);
});

test("catalog writer respects a slow writable and leaves it open for its owner", async () => {
  const expected = [session("one"), session("two")];
  const firstWritten = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const chunks: Buffer[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      if (chunks.length === 1) {
        firstWritten.resolve();
        void releaseFirst.promise.then(() => callback());
      } else callback();
    },
  });
  const pending = writeSessionCatalog(expected, output);
  await firstWritten.promise;
  await Bun.sleep(5);
  assert.equal(
    output.writableLength,
    chunks[0]!.length,
    "only the first frame may be queued while the sink is blocked",
  );
  releaseFirst.resolve();
  await pending;
  assert.equal(output.writableEnded, false);
  assert.deepEqual(await readSessionCatalog(streamChunks(chunks)), expected);
  output.end();
});

test("catalog writer propagates pipe errors", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("broken pipe"));
    },
  });
  await assert.rejects(writeSessionCatalog([session("one")], output), /broken pipe/);
});
