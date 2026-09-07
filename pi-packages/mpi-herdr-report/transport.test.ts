import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildReportAgentRequest, sendRequestAttempt } from "./index.js";

async function attemptWithReply(reply: (socket: net.Socket, id: string) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-herdr-transport-"));
  const socketPath = path.join(dir, "herdr.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A client rejecting an incomplete response can close before the server finishes writing.
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer) as { id: string };
      reply(socket, request.id);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    return await sendRequestAttempt(buildReportAgentRequest("w1:p1", "working", 1), 100, {
      MIXCODE: "1",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PANE_ID: "w1:p1",
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a matching Herdr success response confirms delivery", async () => {
  assert.equal(
    await attemptWithReply((socket, id) => {
      socket.end(`${JSON.stringify({ id, result: { type: "ok" } })}\n`);
    }),
    true,
  );
});

test("Herdr error responses do not confirm delivery", async () => {
  assert.equal(
    await attemptWithReply((socket, id) => {
      socket.end(
        `${JSON.stringify({ id, error: { code: "pane_not_found", message: "Missing pane" } })}\n`,
      );
    }),
    false,
  );
});

test("an unrelated request's success response does not confirm delivery", async () => {
  assert.equal(
    await attemptWithReply((socket) => {
      socket.end(`${JSON.stringify({ id: "another-request", result: { type: "ok" } })}\n`);
    }),
    false,
  );
});

test("a truncated response does not confirm delivery", async () => {
  assert.equal(
    await attemptWithReply((socket, id) => {
      socket.end(`{"id":${JSON.stringify(id)},"result":`);
    }),
    false,
  );
});

test("malformed JSON does not confirm delivery", async () => {
  assert.equal(await attemptWithReply((socket) => socket.end("not-json\n")), false);
});

test("an unfinished response times out as a failed delivery", async () => {
  assert.equal(await attemptWithReply((socket) => socket.write("{")), false);
});

test("delivery waits for the complete response across socket chunks", async () => {
  assert.equal(
    await attemptWithReply((socket, id) => {
      socket.write(`{"id":${JSON.stringify(id)},`);
      const timer = setTimeout(() => {
        socket.end('"error":{"code":"busy","message":"Try again"}}\n');
      }, 20);
      socket.on("close", () => clearTimeout(timer));
    }),
    false,
  );
});
