import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionSyncCoordinator,
  type FileFingerprint,
  type SessionWatchFactory,
} from "../src/index.js";

// A controllable watcher: tests push events through `emit`; closing flips a flag.
function makeControllableWatch(): {
  factory: SessionWatchFactory;
  emit: (filename: string | null) => void;
  closed: () => boolean;
  watchCount: () => number;
} {
  let emit!: (filename: string | null) => void;
  let closed = false;
  let watchCount = 0;
  const factory: SessionWatchFactory = (_dir, onEvent) => {
    watchCount += 1;
    emit = onEvent;
    return { close: () => { closed = true; } };
  };
  return { factory, emit: (f) => emit(f), closed: () => closed, watchCount: () => watchCount };
}

// A mutable fingerprint table keyed by absolute path; `bump` simulates a write.
function makeStatTable(): {
  stat: (filePath: string) => FileFingerprint | undefined;
  set: (fileName: string, fp: FileFingerprint) => void;
} {
  const table = new Map<string, FileFingerprint>();
  return {
    stat: (filePath) => {
      // Coordinator passes join(root, fileName); match on the basename tail.
      for (const [name, fp] of table) if (filePath.endsWith(name)) return fp;
      return undefined;
    },
    set: (fileName, fp) => table.set(fileName, fp),
  };
}

test("only one watcher is created regardless of session count", () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: () => {},
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 0,
  });
  stat.set("a.jsonl", { size: 1, mtimeMs: 1 });
  stat.set("b.jsonl", { size: 1, mtimeMs: 1 });
  coord.register("sa", "/root/a.jsonl");
  coord.register("sb", "/root/b.jsonl");
  assert.equal(w.watchCount(), 1);
  coord.dispose();
  assert.equal(w.closed(), true);
});

test("a real fingerprint change triggers exactly one debounced reload", async () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 5,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");

  // External append: size + mtime grow. Fire several watcher events for it.
  stat.set("a.jsonl", { size: 40, mtimeMs: 200 });
  w.emit("a.jsonl");
  w.emit("a.jsonl");
  w.emit("a.jsonl");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(changed, ["sa"], "burst collapses to one reload");
  coord.dispose();
});

test("repeat events with an unchanged fingerprint do not reload", async () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 5,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  // Same fingerprint -> not a real change.
  w.emit("a.jsonl");
  w.emit("a.jsonl");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(changed, []);
  coord.dispose();
});

test("events for an unrelated file are ignored", async () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 5,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  stat.set("other.jsonl", { size: 999, mtimeMs: 999 });
  w.emit("other.jsonl");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(changed, []);
  coord.dispose();
});

test("markLocalWrite suppresses the echo reload of our own write", async () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 5,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  // Local write grows the file; we record it BEFORE the watcher event lands.
  stat.set("a.jsonl", { size: 30, mtimeMs: 300 });
  coord.markLocalWrite("sa");
  w.emit("a.jsonl");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(changed, [], "our own write must not echo back as a reload");
  coord.dispose();
});

test("filename-less events re-check only registered sessions", async () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 5,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  stat.set("a.jsonl", { size: 20, mtimeMs: 200 });
  w.emit(null); // platform without filename
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(changed, ["sa"]);
  coord.dispose();
});

test("unregister stops reloads and clears pending timers", async () => {
  const w = makeControllableWatch();
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    watchFactory: w.factory,
    statFingerprint: stat.stat,
    debounceMs: 20,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  stat.set("a.jsonl", { size: 20, mtimeMs: 200 });
  w.emit("a.jsonl"); // schedules a debounced reload
  coord.unregister("sa"); // ...which must be cancelled
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(changed, []);
  coord.dispose();
});
