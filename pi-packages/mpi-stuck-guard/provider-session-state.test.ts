import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createWatchdogRegistry, createWatchdogSession } from "../../test/helpers/stuck-guard.js";

/** Synthetic transport with a bounded completion and real AbortSignal cleanup. */
function delayedStream(delayMs: number, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const timer = setTimeout(() => {
    options?.signal?.removeEventListener("abort", abort);
    stream.push({
      type: "done",
      reason: "stop",
      message: fauxAssistantMessage("done", { stopReason: "stop" }),
    });
  }, delayMs);
  const abort = () => {
    clearTimeout(timer);
    stream.push({
      type: "error",
      reason: "aborted",
      error: fauxAssistantMessage("", { stopReason: "aborted" }),
    });
  };
  options?.signal?.addEventListener("abort", abort, { once: true });
  if (options?.signal?.aborted) abort();
  return stream;
}

test("a timeout in one session does not shorten or disable another session's start window", async () => {
  const fixture = await createWatchdogRegistry();
  const config = {
    providerIds: [fixture.providerId],
    streamStartTimeoutSeconds: 1,
    streamRetryStartTimeoutSeconds: 0,
    knownTimeoutCooldownSeconds: 0,
  };
  const first = createWatchdogSession(fixture.registry, config);
  const second = createWatchdogSession(new ModelRegistry(fixture.runtime), config);
  fixture.setOpen((options) => delayedStream(1300, options));
  try {
    await first.emit("session_start");
    await second.emit("session_start");
    const firstResult = await fixture.request(first.session.getSessionId());
    assert.equal(firstResult.stopReason, "error");
    assert.match(firstResult.errorMessage ?? "", /stream start timeout/);
    const secondResult = await fixture.request(second.session.getSessionId());
    assert.equal(secondResult.stopReason, "error");
    assert.match(secondResult.errorMessage ?? "", /stream start timeout/);
    // This retry uses A's disabled retry-start timer, so a >1s transport succeeds.
    const retry = await fixture.request(first.session.getSessionId());
    assert.equal(retry.stopReason, "stop");
    assert.equal((await first.stats()).providerStartTimeouts, 1);
    assert.equal((await first.stats()).providerCompletions, 1);
    assert.equal((await second.stats()).providerStartTimeouts, 1);
    assert.equal((await second.stats()).providerCompletions, 0);
  } finally {
    await first.emit("session_shutdown");
    await second.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("configuration reload changes later requests without changing an active request", async () => {
  const fixture = await createWatchdogRegistry();
  const session = createWatchdogSession(fixture.registry, {
    providerIds: [fixture.providerId],
    streamStartTimeoutSeconds: 0,
  });
  const opened = Promise.withResolvers<void>();
  fixture.setOpen((options) => {
    opened.resolve();
    return delayedStream(1300, options);
  });
  try {
    await session.emit("session_start");
    const active = fixture.request(session.session.getSessionId());
    await opened.promise;
    session.updateConfig({ streamStartTimeoutSeconds: 1 });
    await session.emit("before_agent_start");
    const later = fixture.request(session.session.getSessionId());
    const [activeResult, laterResult] = await Promise.all([active, later]);
    assert.equal(activeResult.stopReason, "stop");
    assert.equal(laterResult.stopReason, "error");
    assert.match(laterResult.errorMessage ?? "", /stream start timeout/);
    const stats = await session.stats();
    assert.equal(stats.providerAttempts, 2);
    assert.equal(stats.providerCompletions, 1);
    assert.equal(stats.providerStartTimeouts, 1);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("session restart resets both statistics and a retained retry cooldown", async () => {
  const fixture = await createWatchdogRegistry();
  const session = createWatchdogSession(fixture.registry, {
    providerIds: [fixture.providerId],
    streamStartTimeoutSeconds: 1,
    streamRetryStartTimeoutSeconds: 0,
    knownTimeoutCooldownSeconds: 0,
  });
  fixture.setOpen((options) => delayedStream(1300, options));
  try {
    await session.emit("session_start");
    assert.equal((await fixture.request(session.session.getSessionId())).stopReason, "error");
    await session.emit("session_start");
    assert.equal((await session.stats()).providerAttempts, 0);
    const restarted = await fixture.request(session.session.getSessionId());
    assert.equal(restarted.stopReason, "error");
    assert.match(restarted.errorMessage ?? "", /stream start timeout/);
    assert.equal((await session.stats()).providerAttempts, 1);
    assert.equal((await session.stats()).providerStartTimeouts, 1);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});
