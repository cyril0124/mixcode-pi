import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeReviewPrompt,
  createReviewDraft,
  type ReviewTarget,
  saveReviewComment,
} from "./review.js";

test("saving the same review target edits it and blank content deletes it", () => {
  const target: ReviewTarget = {
    kind: "line",
    path: "src/a.ts",
    side: "new",
    startLine: 18,
    endLine: 20,
    code: ["const value = input.value;"],
  };

  const created = saveReviewComment(createReviewDraft(), target, "Handle null input.", "fix");
  const edited = saveReviewComment(created, target, "Explain the null contract.", "discuss");
  const deleted = saveReviewComment(edited, target, "   ", "discuss");

  assert.deepEqual(edited.comments, [
    { target, body: "Explain the null contract.", intent: "discuss" },
  ]);
  assert.deepEqual(deleted.comments, []);
});

test("review prompt separates intents and quotes only selected line code", () => {
  let draft = createReviewDraft();
  draft = saveReviewComment(
    draft,
    { kind: "file", path: "src/b.ts" },
    "Is this needed?",
    "discuss",
  );
  draft = saveReviewComment(
    draft,
    {
      kind: "line",
      path: "src/a.ts",
      side: "new",
      startLine: 18,
      endLine: 19,
      code: ["const value = input.value;", "return value;"],
    },
    "Handle null input.",
    "fix",
  );
  draft = saveReviewComment(draft, { kind: "all" }, "Keep the public API stable.", "fix");

  const prompt = composeReviewPrompt(draft);

  assert.match(prompt, /For FIX items: make the requested changes\./);
  assert.match(prompt, /For DISCUSS items: do not edit files/);
  assert.ok(prompt.indexOf("FIX") < prompt.indexOf("DISCUSS"));
  assert.match(prompt, /Review-wide:\nKeep the public API stable\./);
  assert.match(
    prompt,
    /src\/a\.ts:18-19 \(added\)\n {3}Comment: Handle null input\.\n {3}Code:\n {7}const value = input\.value;\n {7}return value;/,
  );
  assert.match(prompt, /DISCUSS[\s\S]*Files:\n- src\/b\.ts\n {2}Is this needed\?/);
});
