import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  AssistantMessageComponent,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import workingTimer, { formatClockTime, formatElapsed, WORKING_TIMER_STATUS_KEY } from "./index.js";

const DONE_TEXT = /^✔ done .+ at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface StatusWrite {
  key: string;
  text: string | undefined;
}

interface Harness {
  session: SessionManager;
  fire(event: string): void;
  /** Emit an event the package deliberately ignores (e.g. `agent_end`). */
  emit(event: string): void;
  writes: StatusWrite[];
  latest(): string | undefined;
  tick(): void;
  liveTickerCount(): number;
  advance(ms: number): void;
  dispose(): void;
}

/**
 * Registers the extension against a fake host: a controllable clock, an interval
 * registry, and a recording `setStatus`.
 */
function createHarness(startMs = 1_000_000, host: "mixcode" | "pi" = "mixcode"): Harness {
  const originalMixCode = process.env.MIXCODE;
  if (host === "mixcode") process.env.MIXCODE = "1";
  else delete process.env.MIXCODE;
  const session = SessionManager.inMemory();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const writes: StatusWrite[] = [];
  const tickers = new Map<number, () => void>();
  let nextTickerId = 1;
  let now = startMs;

  const realDateNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;

  Date.now = () => now;
  globalThis.setInterval = ((fn: () => void) => {
    const id = nextTickerId++;
    tickers.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    tickers.delete(id as number);
  }) as typeof clearInterval;

  const ctx = {
    sessionManager: session,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        writes.push({ key, text });
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  workingTimer(pi);

  return {
    session,
    fire: (event) => {
      const handler = handlers.get(event);
      assert.ok(handler, `no handler registered for ${event}`);
      handler({}, ctx);
    },
    emit: (event) => {
      handlers.get(event)?.({}, ctx);
    },
    writes,
    latest: () => writes.at(-1)?.text,
    tick: () => {
      for (const fn of [...tickers.values()]) fn();
    },
    liveTickerCount: () => tickers.size,
    advance: (ms) => {
      now += ms;
    },
    dispose: () => {
      if (originalMixCode === undefined) delete process.env.MIXCODE;
      else process.env.MIXCODE = originalMixCode;
      Date.now = realDateNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

test("restores the last visible message timestamp on the active branch despite a hidden tail", () => {
  const harness = createHarness(new Date(2026, 9, 9, 12).getTime());
  try {
    for (let index = 0; index < 32; index++) {
      harness.session.appendMessage({
        role: "user",
        content: `Question ${index}`,
        timestamp: new Date(2026, 9, 3, 15, 0, index).getTime(),
      });
      harness.session.appendMessage({
        ...fauxAssistantMessage(`Answer ${index}`),
        timestamp: new Date(2026, 9, 3, 15, 1, index).getTime(),
      });
    }
    const visibleId = harness.session.appendMessage({
      ...fauxAssistantMessage("Visible completed answer"),
      timestamp: new Date(2026, 9, 3, 15, 39).getTime(),
    });
    harness.session.appendMessage({
      ...fauxAssistantMessage("Abandoned branch answer"),
      timestamp: new Date(2026, 9, 8, 20).getTime(),
    });
    harness.session.branch(visibleId);
    harness.session.appendMessage({
      role: "custom",
      customType: "background-status",
      content: "Hidden later message",
      display: false,
      timestamp: new Date(2026, 9, 8, 21).getTime(),
    });
    harness.session.appendCustomMessageEntry("background-context", "Hidden entry", false);
    harness.session.appendMessage({
      role: "system",
      content: "Internal prompt update",
      timestamp: new Date(2026, 9, 8, 22).getTime(),
    });
    harness.session.appendMessage({
      ...fauxAssistantMessage("  "),
      timestamp: new Date(2026, 9, 8, 23).getTime(),
    });
    harness.session.appendMessage({ role: "user", content: "", timestamp: Date.now() });
    harness.session.appendCustomEntry("extension-state", { background: true });
    harness.session.appendSessionInfo("Restored conversation");
    harness.session.appendModelChange("faux", "faux");
    harness.session.appendUsage("cache_warm", "faux", "faux", fauxAssistantMessage("").usage);
    // Context edits change model input; the original answer remains visible in history.
    harness.session.appendContextEdit(visibleId, null);

    harness.fire("session_start");
    assert.equal(harness.latest(), "✔ done at 2026-10-03 15:39:00");
    assert.equal(harness.liveTickerCount(), 0);
    const restoredWrites = harness.writes.length;
    harness.advance(60_000);
    harness.tick();
    assert.equal(harness.writes.length, restoredWrites);
  } finally {
    harness.dispose();
  }
});

test("restores a tool result's timestamp only when its call is visible on the active branch", () => {
  const harness = createHarness();
  try {
    harness.session.appendMessage({
      ...fauxAssistantMessage([
        { type: "toolCall", id: "visible-call", name: "read", arguments: { path: "example.txt" } },
      ]),
      timestamp: new Date(2026, 9, 3, 15, 38).getTime(),
    });
    harness.session.appendMessage({
      role: "toolResult",
      toolCallId: "visible-call",
      toolName: "read",
      content: [{ type: "text", text: "Visible file content" }],
      isError: false,
      timestamp: new Date(2026, 9, 3, 15, 39).getTime(),
    });
    harness.session.appendMessage({
      role: "toolResult",
      toolCallId: "missing-call",
      toolName: "read",
      content: [{ type: "text", text: "Orphan result is not rendered" }],
      isError: false,
      timestamp: new Date(2026, 9, 3, 15, 40).getTime(),
    });
    harness.fire("session_start");
    assert.equal(harness.latest(), "✔ done at 2026-10-03 15:39:00");
  } finally {
    harness.dispose();
  }
});

for (const host of ["mixcode", "pi"] as const) {
  test(`${host} restoration matches the visibility of empty redacted thinking`, () => {
    const harness = createHarness(undefined, host);
    try {
      harness.session.appendMessage({
        role: "user",
        content: "Visible question",
        timestamp: new Date(2026, 0, 1, 12).getTime(),
      });
      const message = {
        ...fauxAssistantMessage([{ type: "thinking", thinking: "", redacted: true }]),
        timestamp: new Date(2026, 0, 2, 12).getTime(),
      };
      harness.session.appendMessage(message);
      if (host === "pi") {
        initTheme("dark");
        assert.deepEqual(new AssistantMessageComponent(message).render(80), []);
      }
      harness.fire("session_start");
      assert.equal(
        harness.latest(),
        host === "mixcode" ? "✔ done at 2026-01-02 12:00:00" : "✔ done at 2026-01-01 12:00:00",
      );
    } finally {
      harness.dispose();
    }
  });

  test(`${host} restoration matches repeated tool result visibility`, () => {
    const harness = createHarness(undefined, host);
    try {
      harness.session.appendMessage({
        ...fauxAssistantMessage([
          {
            type: "toolCall",
            id: "repeated-call",
            name: "read",
            arguments: { path: "example.txt" },
          },
        ]),
        timestamp: new Date(2026, 0, 1, 12).getTime(),
      });
      for (const day of [2, 3]) {
        harness.session.appendMessage({
          role: "toolResult",
          toolCallId: "repeated-call",
          toolName: "read",
          content: [{ type: "text", text: `Result ${day}` }],
          isError: false,
          timestamp: new Date(2026, 0, day, 12).getTime(),
        });
      }
      harness.fire("session_start");
      assert.equal(
        harness.latest(),
        host === "mixcode" ? "✔ done at 2026-01-03 12:00:00" : "✔ done at 2026-01-02 12:00:00",
      );
    } finally {
      harness.dispose();
    }
  });

  test(`${host} restoration matches tool result visibility across compaction`, () => {
    const harness = createHarness(undefined, host);
    try {
      harness.session.appendMessage({
        ...fauxAssistantMessage([
          {
            type: "toolCall",
            id: "compacted-call",
            name: "read",
            arguments: { path: "example.txt" },
          },
        ]),
        timestamp: new Date(2026, 0, 1, 12).getTime(),
      });
      const keptId = harness.session.appendMessage({
        role: "user",
        content: "Retained question",
        timestamp: new Date(2026, 0, 2, 12).getTime(),
      });
      harness.session.appendCompaction("Compacted earlier tool call", keptId, 42_000);
      harness.session.appendMessage({
        role: "toolResult",
        toolCallId: "compacted-call",
        toolName: "read",
        content: [{ type: "text", text: "Result after compaction" }],
        isError: false,
        timestamp: new Date(2026, 0, 3, 12).getTime(),
      });
      harness.fire("session_start");
      assert.equal(
        harness.latest(),
        host === "mixcode" ? "✔ done at 2026-01-03 12:00:00" : "✔ done at 2026-01-02 12:00:00",
      );
    } finally {
      harness.dispose();
    }
  });

  for (const stopReason of ["aborted", "error"] as const) {
    test(`${host} restoration matches tool results after an ${stopReason} assistant`, () => {
      const harness = createHarness(undefined, host);
      try {
        harness.session.appendMessage({
          ...fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "failed-call",
                name: "read",
                arguments: { path: "example.txt" },
              },
            ],
            { stopReason, errorMessage: "Interrupted tool call" },
          ),
          timestamp: new Date(2026, 0, 1, 12).getTime(),
        });
        harness.session.appendMessage({
          role: "toolResult",
          toolCallId: "failed-call",
          toolName: "read",
          content: [{ type: "text", text: "Unmatched result in Pi" }],
          isError: false,
          timestamp: new Date(2026, 0, 2, 12).getTime(),
        });
        harness.fire("session_start");
        assert.equal(
          harness.latest(),
          host === "mixcode" ? "✔ done at 2026-01-02 12:00:00" : "✔ done at 2026-01-01 12:00:00",
        );
      } finally {
        harness.dispose();
      }
    });
  }

  test(`${host} restoration matches user images without text`, () => {
    const harness = createHarness(undefined, host);
    try {
      harness.session.appendMessage({
        ...fauxAssistantMessage("Visible answer"),
        timestamp: new Date(2026, 0, 1, 12).getTime(),
      });
      harness.session.appendMessage({
        role: "user",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        timestamp: new Date(2026, 0, 2, 12).getTime(),
      });
      harness.fire("session_start");
      assert.equal(
        harness.latest(),
        host === "mixcode" ? "✔ done at 2026-01-02 12:00:00" : "✔ done at 2026-01-01 12:00:00",
      );
    } finally {
      harness.dispose();
    }
  });

  test(`${host} restoration matches an assistant error without content`, () => {
    const harness = createHarness(undefined, host);
    try {
      harness.session.appendMessage({
        role: "user",
        content: "Visible question",
        timestamp: new Date(2026, 0, 1, 12).getTime(),
      });
      const message = {
        ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider failed" }),
        timestamp: new Date(2026, 0, 2, 12).getTime(),
      };
      harness.session.appendMessage(message);
      if (host === "pi") {
        initTheme("dark");
        assert.match(
          new AssistantMessageComponent(message).render(80).join("\n"),
          /Provider failed/,
        );
      }
      harness.fire("session_start");
      assert.equal(
        harness.latest(),
        host === "mixcode" ? "✔ done at 2026-01-01 12:00:00" : "✔ done at 2026-01-02 12:00:00",
      );
    } finally {
      harness.dispose();
    }
  });
}

test("restores a visible custom message's own timestamp", () => {
  const harness = createHarness();
  try {
    harness.session.appendMessage({
      role: "custom",
      customType: "visible-status",
      content: "Shown completion notice",
      display: true,
      timestamp: new Date(2026, 0, 9, 4, 5, 6).getTime(),
    });
    harness.session.appendCustomMessageEntry("background-context", "Hidden context", false);
    harness.fire("session_start");
    assert.equal(harness.latest(), "✔ done at 2026-01-09 04:05:06");
  } finally {
    harness.dispose();
  }
});

for (const kind of ["custom_message", "compaction", "branch_summary"] as const) {
  test(`restores the message timestamp from a visible ${kind} entry`, () => {
    const harness = createHarness();
    try {
      const userId = harness.session.appendMessage({
        role: "user",
        content: "Earlier question",
        timestamp: 1,
      });
      let entryId: string;
      if (kind === "custom_message") {
        entryId = harness.session.appendCustomMessageEntry("visible-note", "Shown notice", true);
      } else if (kind === "compaction") {
        entryId = harness.session.appendCompaction("Visible summary", userId, 42_000);
      } else {
        entryId = harness.session.branchWithSummary(userId, "Visible branch summary");
      }
      const entry = harness.session.getEntry(entryId);
      assert.ok(entry);
      const expectedClock = new Date(entry.timestamp).toLocaleString("sv-SE", { hour12: false });
      harness.session.appendSessionInfo("Newer metadata");
      harness.fire("session_start");
      assert.equal(harness.latest(), `✔ done at ${expectedClock}`);
    } finally {
      harness.dispose();
    }
  });
}

test("tree navigation restores the selected branch and a subsequent run keeps its timing", () => {
  const harness = createHarness(new Date(2026, 9, 9, 12).getTime());
  try {
    const firstId = harness.session.appendMessage({
      ...fauxAssistantMessage("First answer"),
      timestamp: new Date(2026, 9, 3, 15, 39).getTime(),
    });
    harness.session.appendMessage({
      ...fauxAssistantMessage("Second answer"),
      timestamp: new Date(2026, 9, 4, 16, 40).getTime(),
    });
    harness.fire("session_start");
    assert.equal(harness.latest(), "✔ done at 2026-10-04 16:40:00");
    harness.session.branch(firstId);
    harness.fire("session_tree");
    assert.equal(harness.latest(), "✔ done at 2026-10-03 15:39:00");
    assert.equal(harness.liveTickerCount(), 0);

    harness.fire("agent_start");
    harness.advance(3_000);
    harness.tick();
    assert.equal(harness.latest(), "⏱ 3s · 3s idle");
    harness.fire("message_update");
    assert.equal(harness.latest(), "⏱ 3s · 0s idle");
    harness.advance(2_000);
    harness.fire("agent_settled");
    assert.equal(harness.latest(), "✔ done 5s at 2026-10-09 12:00:05");
    assert.equal(harness.liveTickerCount(), 0);
    harness.fire("session_shutdown");
    assert.equal(harness.latest(), undefined);
  } finally {
    harness.dispose();
  }
});

test("a history containing only hidden messages and state has no restored done time", () => {
  const harness = createHarness();
  try {
    harness.session.appendMessage({ role: "system", content: "Prompt", timestamp: 1 });
    harness.session.appendCustomMessageEntry("hidden-note", "Internal context", false);
    harness.session.appendCustomEntry("state", { ready: true });
    harness.session.appendMessage({ ...fauxAssistantMessage(""), timestamp: 2 });
    harness.fire("session_start");
    assert.equal(harness.latest(), undefined);
    assert.equal(harness.liveTickerCount(), 0);
  } finally {
    harness.dispose();
  }
});

test("holds the running clock across agent loops and settles it once agent_settled arrives", () => {
  const harness = createHarness();
  try {
    harness.fire("session_start");
    assert.equal(harness.latest(), undefined);

    harness.fire("agent_start");
    assert.equal(harness.latest(), "⏱ 0s · 0s idle");

    harness.advance(3_000);
    harness.fire("tool_execution_start");
    assert.equal(harness.latest(), "⏱ 3s · 0s idle");

    // An auto-retry / compaction / continuation run ends one agent loop without
    // ending the run: the clock keeps counting into the next loop.
    harness.emit("agent_end");
    assert.equal(harness.latest(), "⏱ 3s · 0s idle");

    harness.advance(2_000);
    harness.fire("agent_start");
    assert.equal(harness.latest(), "⏱ 5s · 0s idle");

    harness.fire("agent_settled");
    assert.match(harness.latest() ?? "", DONE_TEXT);
    assert.ok(harness.latest()?.startsWith("✔ done 5s at "), harness.latest());
    assert.equal(harness.liveTickerCount(), 0);

    // The next run starts a fresh clock.
    harness.advance(1_000);
    harness.fire("agent_start");
    assert.equal(harness.latest(), "⏱ 0s · 0s idle");
  } finally {
    harness.dispose();
  }
});

test("keeps exactly one ticker per run and stops it on agent_settled", () => {
  const harness = createHarness();
  try {
    harness.fire("agent_start");
    assert.equal(harness.liveTickerCount(), 1);

    harness.advance(1_000);
    harness.tick();
    assert.equal(harness.latest(), "⏱ 1s · 1s idle");

    // A second agent_start in the same run replaces the ticker instead of stacking.
    harness.fire("agent_start");
    assert.equal(harness.liveTickerCount(), 1);

    harness.advance(4_000);
    harness.fire("agent_settled");
    assert.equal(harness.liveTickerCount(), 0);
    assert.ok(harness.latest()?.startsWith("✔ done 5s at "), harness.latest());

    // An idle session schedules no further renders.
    const writesAfterEnd = harness.writes.length;
    harness.advance(10_000);
    harness.tick();
    assert.equal(harness.writes.length, writesAfterEnd);
  } finally {
    harness.dispose();
  }
});

test("clears the footer entry and the ticker on session boundaries", () => {
  const harness = createHarness();
  try {
    harness.fire("agent_start");
    harness.advance(2_000);
    harness.fire("agent_settled");
    assert.ok(harness.latest()?.startsWith("✔ done 2s at "), harness.latest());

    harness.fire("session_start");
    assert.equal(harness.latest(), undefined);

    harness.fire("agent_start");
    assert.equal(harness.liveTickerCount(), 1);
    harness.fire("session_shutdown");
    assert.equal(harness.latest(), undefined);
    assert.equal(harness.liveTickerCount(), 0);
  } finally {
    harness.dispose();
  }
});

test("writes every status under the documented key", () => {
  const harness = createHarness();
  try {
    harness.fire("agent_start");
    harness.advance(61_000);
    harness.fire("tool_execution_end");
    harness.fire("agent_settled");
    assert.deepEqual(
      harness.writes.map((write) => write.key),
      [WORKING_TIMER_STATUS_KEY, WORKING_TIMER_STATUS_KEY, WORKING_TIMER_STATUS_KEY],
    );
    assert.ok(harness.latest()?.startsWith("✔ done 1m 01s at "), harness.latest());
  } finally {
    harness.dispose();
  }
});

test("formats the finish stamp as a local YYYY-MM-DD HH:MM:SS clock", () => {
  // Both the construction and the formatting use local time, so this holds in any TZ.
  assert.equal(formatClockTime(new Date(2026, 9, 3, 15, 39, 0).getTime()), "2026-10-03 15:39:00");
  assert.equal(formatClockTime(new Date(2026, 0, 9, 4, 5, 6).getTime()), "2026-01-09 04:05:06");
});

test("formats durations with mixed units", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(7_200_000), "2h 00m 00s");
});
