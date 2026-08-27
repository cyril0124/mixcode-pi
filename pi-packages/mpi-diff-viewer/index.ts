import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createDiffViewerComponent } from "./diff-viewer.js";
import { composeReviewPrompt, type ReviewDraft } from "./review.js";
import {
  buildGitDiff,
  buildSessionDiff,
  type SessionDiff,
  type SessionEntry,
} from "./session-diff.js";

function userMessageIndexes(entries: SessionEntry[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < entries.length; index++) {
    if (entries[index]?.type === "message" && entries[index]?.message?.role === "user") {
      indexes.push(index);
    }
  }
  return indexes;
}

function getRangeTurnSlice(
  entries: SessionEntry[],
  first: number,
  last: number,
): { baseline: SessionEntry[]; scope: SessionEntry[] } {
  const indexes = userMessageIndexes(entries);
  const farthest = Math.max(first, last);
  const nearest = Math.min(first, last);
  if (nearest < 1 || farthest > indexes.length) return { baseline: [], scope: [] };
  const start = indexes[indexes.length - farthest]!;
  const end = nearest > 1 ? indexes[indexes.length - nearest + 1]! : entries.length;
  return { baseline: entries.slice(0, start), scope: entries.slice(start, end) };
}

async function openDiff(
  diff: SessionDiff,
  ctx: Pick<ExtensionCommandContext, "ui">,
  emptyMessage: string,
): Promise<void> {
  if (diff.trackedFiles === 0) {
    ctx.ui.notify(emptyMessage, "info");
    return;
  }
  if (diff.files.length === 0) {
    ctx.ui.notify("Files were modified but have no text changes to display.", "info");
    return;
  }

  const review = await ctx.ui.custom<ReviewDraft | undefined>(
    (tui, theme, _keybindings, done) => createDiffViewerComponent({ tui, theme, diff, done }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        maxHeight: "100%",
        minWidth: 40,
        margin: 1,
      },
    },
  );
  if (!review) return;
  const prompt = composeReviewPrompt(review);
  const existing = ctx.ui.getEditorText?.() ?? "";
  ctx.ui.setEditorText(existing.trim() ? `${existing.replace(/\s*$/, "")}\n\n${prompt}` : prompt);
  ctx.ui.notify("Inserted review feedback into the editor.", "info");
}

async function showDiff(
  entries: SessionEntry[],
  cwd: string,
  ctx: Pick<ExtensionCommandContext, "ui">,
  baselineEntries: SessionEntry[] = [],
): Promise<void> {
  if (entries.length === 0) {
    ctx.ui.notify("No entries found for the specified range.", "info");
    return;
  }
  await openDiff(
    buildSessionDiff(entries, cwd, baselineEntries),
    ctx,
    "No file modifications found in this session.",
  );
}

async function showGitDiff(
  cwd: string,
  ref: string,
  ctx: Pick<ExtensionCommandContext, "ui">,
): Promise<void> {
  let diff: SessionDiff;
  try {
    diff = buildGitDiff(cwd, ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Error: ${message}`, "error");
    return;
  }
  await openDiff(diff, ctx, `No file modifications found against ${ref}.`);
}

const extension: ExtensionFactory = (pi) => {
  pi.registerCommand("diff", {
    description: "Show session or git file changes in the built-in diff viewer",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "last", label: "last", description: "Last turn (= /diff 1)" },
        { value: "1", label: "1", description: "Last turn" },
        { value: "2", label: "2", description: "2nd-to-last turn" },
        { value: "3", label: "3", description: "3rd-to-last turn" },
        { value: "HEAD", label: "HEAD", description: "Uncommitted text changes against HEAD" },
      ];
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
      const value = (args ?? "").trim();
      let scope: SessionEntry[];
      let baseline: SessionEntry[] = [];

      if (!value) scope = entries;
      else if (value === "last") {
        ({ baseline, scope } = getRangeTurnSlice(entries, 1, 1));
      } else if (/^\d+$/.test(value)) {
        const n = Number(value);
        ({ baseline, scope } = getRangeTurnSlice(entries, n, n));
      } else if (/^\d+-\d+$/.test(value)) {
        const [first, last] = value.split("-").map(Number);
        ({ baseline, scope } = getRangeTurnSlice(entries, first!, last!));
      } else {
        await showGitDiff(ctx.cwd, value, ctx);
        return;
      }

      await showDiff(scope, ctx.cwd, ctx, baseline);
    },
  });

  pi.registerCommand("dl", {
    description: "Show file changes from the last turn (alias for /diff last)",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
      const { baseline, scope } = getRangeTurnSlice(entries, 1, 1);
      await showDiff(scope, ctx.cwd, ctx, baseline);
    },
  });
};

export default extension;
