// License notices: ./THIRD_PARTY_NOTICES.md.
// Track cleanup callbacks for reload safety.
//
// Epoch-gated disposal: resetDisposed() increments the epoch and returns it.
// disposeAll(epoch) is a no-op when the provided epoch does not match the
// current one, preventing a stale session_shutdown from killing callbacks that
// were registered by a newer extension instance after resetDisposed() ran.
let cleanupCallbacks: Array<() => void> = [];
let disposed = false;
let currentEpoch = 0;

export function registerCleanup(callback: () => void): () => void {
  if (disposed) {
    callback();
    return () => {};
  }
  cleanupCallbacks.push(callback);
  return () => {
    const index = cleanupCallbacks.indexOf(callback);
    if (index !== -1) cleanupCallbacks.splice(index, 1);
  };
}

export function registerTimer(
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>,
): () => void {
  return registerCleanup(() => clearInterval(timer as ReturnType<typeof setInterval>));
}

export function disposeAll(epoch?: number): void {
  // Ignore stale shutdown calls from a previous extension instance.
  if (epoch !== undefined && epoch !== currentEpoch) return;
  if (disposed) return;
  disposed = true;
  // Snapshot first: a callback may unregister (splice) mid-iteration.
  const callbacks = cleanupCallbacks;
  cleanupCallbacks = [];
  // Run in reverse order (LIFO)
  for (let i = callbacks.length - 1; i >= 0; i--) {
    try {
      callbacks[i]!();
    } catch (cleanupError) {
      // Teardown must not abort remaining cleanup; a cleanup callback can
      // throw only on already-stopped timers/rows, which is safe to surface
      // as a log and keep going.
      console.error("mpi-tool-display cleanup failed:", cleanupError);
    }
  }
}

/** Advance the disposal epoch and reset state. Returns the new epoch token,
 * which callers must pass back to disposeAll() so stale shutdowns are ignored. */
export function resetDisposed(): number {
  disposed = false;
  cleanupCallbacks = [];
  return ++currentEpoch;
}
