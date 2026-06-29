// Keep the selected index centered within a fixed-height scrolling window.
// Returns the first visible index, clamped so the window never runs past the
// start or end of the list. When everything fits, the window starts at 0.
export function windowStart(selectedIndex: number, total: number, windowSize: number): number {
  if (total <= windowSize) return 0;
  return Math.max(0, Math.min(selectedIndex - Math.floor(windowSize / 2), total - windowSize));
}

// Default list height when no explicit row budget is given: half the terminal
// height (min 5), assuming 24 rows when stdout size is unknown.
export function halfScreenRows(): number {
  return Math.max(5, Math.floor((process.stdout.rows || 24) / 2));
}
