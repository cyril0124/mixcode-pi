import type { Writable } from "node:stream";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

const PARSE_TIME_SLICE_MS = 10;

type WireSession = Omit<SessionInfo, "created" | "modified"> & {
  created: string | null;
  modified: string | null;
};

type CatalogFrame = { type: "session"; session: WireSession } | { type: "done"; count: number };

/**
 * Write one JSONL frame per complete session, followed by its count. The caller
 * owns the writable and its lifetime. Waiting for each write callback bounds
 * queued output to one frame and propagates pipe errors before reporting success.
 */
export async function writeSessionCatalog(
  sessions: readonly SessionInfo[],
  output: Writable,
): Promise<void> {
  let streamError: Error | undefined;
  const onError = (error: Error): void => {
    streamError = error;
  };
  output.on("error", onError);
  try {
    const write = async (frame: string): Promise<void> => {
      if (streamError) throw streamError;
      await new Promise<void>((resolve, reject) => {
        output.write(frame, (error) => (error ? reject(error) : resolve()));
      });
      if (streamError) throw streamError;
    };
    for (const session of sessions) {
      await write(`${JSON.stringify({ type: "session", session })}\n`);
    }
    await write(`${JSON.stringify({ type: "done", count: sessions.length })}\n`);
  } finally {
    output.off("error", onError);
  }
}

/**
 * Consume a counted JSONL catalog without retaining the complete wire payload.
 * Returns only after a matching done frame and EOF; malformed/truncated output
 * rejects. The caller must also check process exit before publishing the result.
 * Owns the reader until completion and cancels it on failure or AbortSignal.
 * Scheduling occurs between frames, so an individual session is never truncated.
 */
export async function readSessionCatalog(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  const reader = stream.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    cancellation ??= reader.cancel().catch(() => {
      // An errored/closed pipe may reject cancellation during teardown.
    });
    return cancellation;
  };
  const onAbort = (): void => {
    void cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const sessions: SessionInfo[] = [];
  let complete = false;
  let reachedEof = false;
  let pieces: Uint8Array[] = [];
  let pieceBytes = 0;
  let yieldAt = performance.now() + PARSE_TIME_SLICE_MS;
  try {
    if (signal?.aborted) throw sessionCatalogAbortError();
    for (;;) {
      const chunk = await reader.read();
      if (signal?.aborted) throw sessionCatalogAbortError();
      if (chunk.done) {
        reachedEof = true;
        break;
      }
      const bytes = chunk.value;
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        if (newline < 0) {
          pieces.push(bytes.subarray(start));
          pieceBytes += bytes.length - start;
          break;
        }
        const tail = bytes.subarray(start, newline + 1);
        // Accumulate fragments by reference and copy once, not once per read.
        const frameBytes = pieces.length
          ? Buffer.concat([...pieces, tail], pieceBytes + tail.length)
          : tail;
        pieces = [];
        pieceBytes = 0;
        start = newline + 1;
        if (complete) throw protocolError("data after completion");
        const frame = parseFrame(frameBytes);
        if (frame.type === "done") {
          if (frame.count !== sessions.length) throw protocolError("session count mismatch");
          complete = true;
        } else {
          // JSON.stringify(Date(NaN)) emits null. Preserve the prior wire reader's
          // new Date(null) behavior for that upstream metadata boundary.
          sessions.push({
            ...frame.session,
            created: new Date(frame.session.created ?? 0),
            modified: new Date(frame.session.modified ?? 0),
          });
        }
        if (performance.now() >= yieldAt) {
          await Bun.sleep(0);
          if (signal?.aborted) throw sessionCatalogAbortError();
          yieldAt = performance.now() + PARSE_TIME_SLICE_MS;
        }
      }
    }
    if (pieceBytes > 0) throw protocolError("truncated frame");
    if (!complete) throw protocolError("missing completion");
    return sessions;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!reachedEof) await cancel();
    reader.releaseLock();
  }
}

/**
 * Read and reap a catalog subprocess. Success requires both a complete stream
 * and exit 0. Cancellation or either pipe failing terminates the child; a child
 * ignoring SIGTERM receives SIGKILL after one second. stderr is always drained.
 */
export async function readSessionCatalogProcess(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  const reading = new AbortController();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_000);
    killTimer.unref?.();
  };
  const onAbort = (): void => {
    reading.abort();
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    const sessions = readSessionCatalog(
      child.stdout as ReadableStream<Uint8Array>,
      reading.signal,
    ).catch((error: unknown) => {
      terminate();
      throw error;
    });
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>)
      .text()
      .catch((error: unknown) => {
        reading.abort();
        terminate();
        throw error;
      });
    const [result, errors, exit] = await Promise.allSettled([sessions, stderr, child.exited]);
    if (signal?.aborted) throw sessionCatalogAbortError();
    if (errors.status === "rejected") throw errors.reason;
    if (exit.status === "rejected") throw exit.reason;
    // A protocol failure can cause our SIGTERM; keep its actionable error unless
    // the worker supplied a specific diagnostic on stderr.
    if (exit.value !== 0 && errors.value.trim()) throw new Error(errors.value.trim());
    if (result.status === "rejected") throw result.reason;
    if (exit.value !== 0) throw new Error(`Session listing process exited with code ${exit.value}`);
    return result.value;
  } finally {
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseFrame(bytes: Uint8Array): CatalogFrame {
  const parsed = Bun.JSONL.parseChunk(bytes);
  if (parsed.error || !parsed.done || parsed.values.length !== 1) {
    throw protocolError("invalid JSONL frame");
  }
  const frame = parsed.values[0];
  if (!isRecord(frame)) throw protocolError("invalid frame shape");
  if (frame.type === "done") {
    if (typeof frame.count !== "number" || !Number.isSafeInteger(frame.count) || frame.count < 0) {
      throw protocolError("invalid completion count");
    }
    return { type: "done", count: frame.count };
  }
  if (frame.type !== "session" || !isWireSession(frame.session)) {
    throw protocolError("invalid session frame");
  }
  return { type: "session", session: frame.session };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWireSession(value: unknown): value is WireSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.parentSessionPath === undefined || typeof value.parentSessionPath === "string") &&
    (value.created === null || typeof value.created === "string") &&
    (value.modified === null || typeof value.modified === "string") &&
    typeof value.messageCount === "number" &&
    Number.isSafeInteger(value.messageCount) &&
    value.messageCount >= 0 &&
    typeof value.firstMessage === "string" &&
    typeof value.allMessagesText === "string"
  );
}

function protocolError(detail: string): Error {
  return new Error(`Error: Invalid session catalog stream: ${detail}`);
}

export function sessionCatalogAbortError(): Error {
  const error = new Error("Session listing cancelled");
  error.name = "AbortError";
  return error;
}
