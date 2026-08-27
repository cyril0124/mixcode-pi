export type QueueBlockItem = {
  objectiveInput: string;
  marker: string;
  lineIndex: number;
};

type OrderedMarkerStyle = "bracket" | "dot" | "paren";
type BulletMarkerStyle = "dash" | "star";

type OrderedMarkerCandidate = {
  kind: "ordered";
  style: OrderedMarkerStyle;
  number: number;
  lineIndex: number;
  /** Marker line with its marker prefix removed. */
  content: string;
  marker: string;
};

type BulletMarkerCandidate = {
  kind: "bullet";
  style: BulletMarkerStyle;
  lineIndex: number;
  /** Marker line with its marker prefix removed. */
  content: string;
  marker: string;
};

type MarkerCandidate = OrderedMarkerCandidate | BulletMarkerCandidate;

export function parseQueueBlockItems(input: string): QueueBlockItem[] | null {
  const lines = input.split(/\r?\n/);
  if (lines.length < 2) return null;
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0) return null;

  const candidates = lines
    .map((line, lineIndex) => parseMarkerCandidate(line, lineIndex))
    .filter((candidate): candidate is MarkerCandidate => candidate !== null);
  if (candidates.length < 2) return null;
  const firstCandidate = candidates.find((candidate) => candidate.lineIndex === firstContentLine);
  if (!firstCandidate) return null;

  const accepted =
    firstCandidate.kind === "bullet"
      ? selectBulletMarkers(firstCandidate, candidates)
      : selectOrderedMarkers(firstCandidate, candidates);
  if (accepted.length < 2) return null;
  return buildQueueBlockItems(lines, accepted);
}

function parseMarkerCandidate(line: string, lineIndex: number): MarkerCandidate | null {
  const bracket = line.match(/^\s*\[(\d+)\]\s*/);
  if (bracket)
    return {
      kind: "ordered",
      style: "bracket",
      number: Number(bracket[1]),
      lineIndex,
      content: line.slice(bracket[0].length),
      marker: `[${bracket[1]}]`,
    };
  const dot = line.match(/^\s*(\d+)\.\s*/);
  if (dot)
    return {
      kind: "ordered",
      style: "dot",
      number: Number(dot[1]),
      lineIndex,
      content: line.slice(dot[0].length),
      marker: `${dot[1]}.`,
    };
  const paren = line.match(/^\s*(\d+)\)\s*/);
  if (paren)
    return {
      kind: "ordered",
      style: "paren",
      number: Number(paren[1]),
      lineIndex,
      content: line.slice(paren[0].length),
      marker: `${paren[1]})`,
    };
  const dash = line.match(/^\s*-\s+/);
  if (dash)
    return {
      kind: "bullet",
      style: "dash",
      lineIndex,
      content: line.slice(dash[0].length),
      marker: "-",
    };
  const star = line.match(/^\s*\*\s+/);
  if (star)
    return {
      kind: "bullet",
      style: "star",
      lineIndex,
      content: line.slice(star[0].length),
      marker: "*",
    };
  return null;
}

function selectBulletMarkers(
  firstCandidate: BulletMarkerCandidate,
  candidates: MarkerCandidate[],
): MarkerCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.kind === "bullet" &&
      candidate.style === firstCandidate.style &&
      candidate.lineIndex >= firstCandidate.lineIndex,
  );
}

function selectOrderedMarkers(
  firstCandidate: OrderedMarkerCandidate,
  candidates: MarkerCandidate[],
): MarkerCandidate[] {
  const ordered = candidates.filter(
    (candidate): candidate is OrderedMarkerCandidate =>
      candidate.kind === "ordered" &&
      candidate.style === firstCandidate.style &&
      candidate.lineIndex >= firstCandidate.lineIndex,
  );
  return bestOrderedSequence(firstCandidate, ordered, new Map<number, OrderedMarkerCandidate[]>());
}

function bestOrderedSequence(
  start: OrderedMarkerCandidate,
  candidates: OrderedMarkerCandidate[],
  memo: Map<number, OrderedMarkerCandidate[]>,
): OrderedMarkerCandidate[] {
  const cached = memo.get(start.lineIndex);
  if (cached) return cached;
  let best: OrderedMarkerCandidate[] = [start];
  for (const next of candidates) {
    if (next.lineIndex <= start.lineIndex || next.number !== start.number + 1) continue;
    const sequence = [start, ...bestOrderedSequence(next, candidates, memo)];
    if (compareMarkerSequences(sequence, best) > 0) best = sequence;
  }
  memo.set(start.lineIndex, best);
  return best;
}

function compareMarkerSequences(
  left: OrderedMarkerCandidate[],
  right: OrderedMarkerCandidate[],
): number {
  // Prefer later equal-length delimiter chains so earlier nested/example markers stay inside the previous objective.
  if (left.length !== right.length) return left.length - right.length;
  const leftLast = left[left.length - 1]?.lineIndex ?? -1;
  const rightLast = right[right.length - 1]?.lineIndex ?? -1;
  if (leftLast !== rightLast) return leftLast - rightLast;
  return sumLineIndexes(left) - sumLineIndexes(right);
}

function sumLineIndexes(candidates: OrderedMarkerCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.lineIndex, 0);
}

function buildQueueBlockItems(lines: string[], accepted: MarkerCandidate[]): QueueBlockItem[] {
  return accepted.map((candidate, index) => {
    const nextLineIndex = accepted[index + 1]?.lineIndex ?? lines.length;
    const itemLines = [candidate.content, ...lines.slice(candidate.lineIndex + 1, nextLineIndex)];
    // Trailing trim() already drops outer blank lines, so no separate blank-line pass is needed.
    return {
      objectiveInput: itemLines.join("\n").trim(),
      marker: candidate.marker,
      lineIndex: candidate.lineIndex,
    };
  });
}
