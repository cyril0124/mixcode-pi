export type ReviewIntent = "fix" | "discuss";
export type ReviewSide = "old" | "new";

export type ReviewTarget =
  | { kind: "all" }
  | { kind: "file"; path: string }
  | {
      kind: "line";
      path: string;
      side: ReviewSide;
      startLine: number;
      endLine: number;
      code: string[];
    };

export interface ReviewComment {
  target: ReviewTarget;
  intent: ReviewIntent;
  body: string;
}

export interface ReviewDraft {
  comments: ReviewComment[];
}

export function createReviewDraft(): ReviewDraft {
  return { comments: [] };
}

export function reviewTargetKey(target: ReviewTarget): string {
  if (target.kind === "all") return "all";
  if (target.kind === "file") return `file:${target.path}`;
  return `line:${target.path}:${target.side}:${target.startLine}:${target.endLine}`;
}

export function saveReviewComment(
  draft: ReviewDraft,
  target: ReviewTarget,
  body: string,
  intent: ReviewIntent,
): ReviewDraft {
  const key = reviewTargetKey(target);
  const comments = draft.comments.filter((comment) => reviewTargetKey(comment.target) !== key);
  const trimmed = body.trim();
  if (trimmed) comments.push({ target, body: trimmed, intent });
  return { comments };
}

export function findReviewComment(
  draft: ReviewDraft,
  target: ReviewTarget,
): ReviewComment | undefined {
  const key = reviewTargetKey(target);
  return draft.comments.find((comment) => reviewTargetKey(comment.target) === key);
}

export function countReviewCommentsForFile(draft: ReviewDraft, path: string): number {
  return draft.comments.filter(
    (comment) => comment.target.kind !== "all" && comment.target.path === path,
  ).length;
}

function compareComments(left: ReviewComment, right: ReviewComment): number {
  const intent = (left.intent === "fix" ? 0 : 1) - (right.intent === "fix" ? 0 : 1);
  if (intent !== 0) return intent;
  const leftPath = left.target.kind === "all" ? "" : left.target.path;
  const rightPath = right.target.kind === "all" ? "" : right.target.path;
  const path = leftPath.localeCompare(rightPath);
  if (path !== 0) return path;
  const kind =
    (left.target.kind === "all" ? 0 : left.target.kind === "file" ? 1 : 2) -
    (right.target.kind === "all" ? 0 : right.target.kind === "file" ? 1 : 2);
  if (kind !== 0) return kind;
  const leftLine = left.target.kind === "line" ? left.target.startLine : -1;
  const rightLine = right.target.kind === "line" ? right.target.startLine : -1;
  return leftLine - rightLine;
}

export function sortedReviewComments(draft: ReviewDraft): ReviewComment[] {
  return [...draft.comments].sort(compareComments);
}

function pushBody(lines: string[], body: string, prefix: string): void {
  for (const line of body.split(/\r?\n/)) lines.push(`${prefix}${line}`);
}

function pushIntentSection(lines: string[], intent: ReviewIntent, comments: ReviewComment[]): void {
  const selected = comments.filter((comment) => comment.intent === intent);
  if (selected.length === 0) return;
  lines.push(intent === "fix" ? "FIX" : "DISCUSS", "");

  const all = selected.find((comment) => comment.target.kind === "all");
  if (all) {
    lines.push("Review-wide:");
    pushBody(lines, all.body, "");
    lines.push("");
  }

  const files = selected.filter((comment) => comment.target.kind === "file");
  if (files.length > 0) {
    lines.push("Files:");
    for (const comment of files) {
      if (comment.target.kind !== "file") continue;
      lines.push(`- ${comment.target.path}`);
      pushBody(lines, comment.body, "  ");
    }
    lines.push("");
  }

  const lineComments = selected.filter((comment) => comment.target.kind === "line");
  if (lineComments.length > 0) {
    lines.push("Lines:");
    lineComments.forEach((comment, index) => {
      if (comment.target.kind !== "line") return;
      const target = comment.target;
      const range =
        target.startLine === target.endLine
          ? `${target.startLine}`
          : `${target.startLine}-${target.endLine}`;
      lines.push(
        `${index + 1}. ${target.path}:${range} (${target.side === "old" ? "deleted" : "added"})`,
      );
      pushBody(lines, comment.body, "   Comment: ");
      lines.push("   Code:");
      for (const codeLine of target.code) lines.push(`       ${codeLine}`);
      if (index < lineComments.length - 1) lines.push("");
    });
    lines.push("");
  }
}

export function composeReviewPrompt(draft: ReviewDraft): string {
  if (draft.comments.length === 0) throw new Error("Cannot compose empty review feedback");
  const comments = sortedReviewComments(draft);
  const hasFix = comments.some((comment) => comment.intent === "fix");
  const hasDiscuss = comments.some((comment) => comment.intent === "discuss");
  const lines = ["Process the following review feedback.", ""];

  if (hasFix && hasDiscuss) {
    lines.push(
      "Rules:",
      "- For FIX items: make the requested changes.",
      "- For DISCUSS items: do not edit files, write code, or make repository changes.",
      "- Answer DISCUSS items in prose only unless the user later explicitly requests implementation.",
      "",
    );
  } else if (hasFix) {
    lines[0] = "Address the following review feedback by making the requested changes.";
  } else {
    lines[0] = "Respond to the following review discussion items in prose only.";
    lines.push("Do not edit files, write code, or make repository changes.", "");
  }

  pushIntentSection(lines, "fix", comments);
  pushIntentSection(lines, "discuss", comments);
  return lines.join("\n").trim();
}
