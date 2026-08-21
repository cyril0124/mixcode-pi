// License notices: ./THIRD_PARTY_NOTICES.md.
// Track cleanup callbacks for reload safety
let cleanupCallbacks: Array<() => void> = [];
let disposed = false;

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

export function disposeAll(): void {
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

export function resetDisposed(): void {
  disposed = false;
  cleanupCallbacks = [];
}
