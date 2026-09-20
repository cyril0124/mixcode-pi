import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEditTool } from "@earendil-works/pi-coding-agent";

type Edit = { oldText: string; newText: string };

async function withEditFile(
  content: string,
  run: (file: string, edit: (edits: Edit[]) => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-edit-fidelity-"));
  const file = path.join(directory, "input.txt");
  try {
    await Bun.write(file, content);
    const tool = createEditTool(directory);
    await run(file, async (edits) => {
      await tool.execute("edit-fidelity", { path: "input.txt", edits });
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("fuzzy edit preserves characters outside a same-line match", async () => {
  await withEditFile("keep “Q”\u3000x ‘target’ tail  \nuntouched — Ａ\t\n", async (file, edit) => {
    await edit([{ oldText: "'target'", newText: "DONE" }]);
    assert.equal(await Bun.file(file).text(), "keep “Q”\u3000x DONE tail  \nuntouched — Ａ\t\n");
  });
});

for (const oldText of ["ix", "f", "ff"]) {
  test(`fuzzy edit rejects partial compatibility expansion ${JSON.stringify(oldText)}`, async () => {
    const original = oldText === "ff" ? "ﬃx\n" : "ﬁx\n";
    await withEditFile(original, async (file, edit) => {
      await assert.rejects(edit([{ oldText, newText: "Z" }]), /Could not find/);
      assert.equal(await Bun.file(file).text(), original);
    });
  });
}

test("complete compatibility and combining sequences remain editable", async () => {
  await withEditFile("前　ﬁx ＡＢ e\u0301 後  \n", async (file, edit) => {
    await edit([
      { oldText: "fix", newText: "fixed" },
      { oldText: "AB", newText: "CD" },
      { oldText: "é", newText: "E" },
    ]);
    assert.equal(await Bun.file(file).text(), "前　fixed CD E 後  \n");
  });
});

test("exact and fuzzy edits use original spans despite normalized length changes", async () => {
  await withEditFile("“keep” ﬃx — Ａ and ‘target’  \n", async (file, edit) => {
    await edit([
      { oldText: "'target'", newText: "done" },
      { oldText: "ﬃx", newText: "longer replacement" },
      { oldText: "A", newText: "B" },
    ]);
    assert.equal(await Bun.file(file).text(), "“keep” longer replacement — B and done  \n");
  });
});

test("fuzzy matches preserve boundary whitespace around multiline replacements", async () => {
  await withEditFile("“keep”   \nＡ  \nＢ  \ntail\t\n", async (file, edit) => {
    await edit([{ oldText: "\nA\nB", newText: "\nchanged" }]);
    assert.equal(await Bun.file(file).text(), "“keep”   \nchanged  \ntail\t\n");
  });
});

test("fuzzy edit retains BOM and CRLF bytes outside the match", async () => {
  await withEditFile("\uFEFF“keep”　‘target’  \r\nnext\t\r\n", async (file, edit) => {
    await edit([{ oldText: "'target'", newText: "done\nmore" }]);
    assert.deepEqual(
      await fs.readFile(file),
      Buffer.from("\uFEFF“keep”　done\r\nmore  \r\nnext\t\r\n"),
    );
  });
});

test("overlapping exact and fuzzy spans reject the whole batch without writing", async () => {
  const original = "“keep” ＡＢＣ ‘target’  \n";
  await withEditFile(original, async (file, edit) => {
    await assert.rejects(
      edit([
        { oldText: "'target'", newText: "done" },
        { oldText: "ABC", newText: "X" },
        { oldText: "ＢＣ", newText: "Y" },
      ]),
      /overlap/,
    );
    assert.equal(await Bun.file(file).text(), original);
  });
});

test("normalized duplicate targets remain ambiguous", async () => {
  const original = "‘target’ and 'target'  \n";
  await withEditFile(original, async (file, edit) => {
    await assert.rejects(edit([{ oldText: "'target'", newText: "done" }]), /2 occurrences/);
    assert.equal(await Bun.file(file).text(), original);
  });
});

for (const { name, original, oldText, expected } of [
  {
    name: "supplementary compatibility character",
    original: "“keep” 𝐀 ‘tail’  ",
    oldText: "A",
    expected: "“keep” Z ‘tail’  ",
  },
  {
    name: "composing Hangul sequence",
    original: "“keep” 각 ‘tail’  ",
    oldText: "각",
    expected: "“keep” Z ‘tail’  ",
  },
  {
    name: "blank line before a match",
    original: "“keep”  \n  \nＡ\t\n",
    oldText: "\n\nA",
    expected: "“keep”  Z\t\n",
  },
  {
    name: "newline at the end of a match",
    original: "“keep”  \nＡ\t\nＢ  \n",
    oldText: "A\n",
    expected: "“keep”  \nZＢ  \n",
  },
]) {
  test(`fuzzy edit maps ${name} to original boundaries`, async () => {
    await withEditFile(original, async (file, edit) => {
      await edit([{ oldText, newText: "Z" }]);
      assert.equal(await Bun.file(file).text(), expected);
    });
  });
}

test("an exact combining-mark edit stays exact when another edit needs fuzzy matching", async () => {
  await withEditFile("e\u0301 ‘target’  \n", async (file, edit) => {
    await edit([
      { oldText: "\u0301", newText: "" },
      { oldText: "'target'", newText: "done" },
    ]);
    assert.equal(await Bun.file(file).text(), "e done  \n");
  });
});

test("an unsafe fuzzy match rejects valid edits in the same batch", async () => {
  const original = "‘target’ ﬁx  \n";
  await withEditFile(original, async (file, edit) => {
    await assert.rejects(
      edit([
        { oldText: "'target'", newText: "done" },
        { oldText: "ix", newText: "Z" },
      ]),
      /Could not find edits\[1\]/,
    );
    assert.equal(await Bun.file(file).text(), original);
  });
});

test("a whitespace-only fuzzy target cannot become an insertion", async () => {
  const original = "Ａ\n";
  await withEditFile(original, async (file, edit) => {
    await assert.rejects(edit([{ oldText: "\t", newText: "Z" }]), /Could not find/);
    assert.equal(await Bun.file(file).text(), original);
  });
});

test("replacement text is not used to match later edits", async () => {
  await withEditFile("Ａ B “keep”  \n", async (file, edit) => {
    await edit([
      { oldText: "A", newText: "B" },
      { oldText: "B", newText: "C" },
    ]);
    assert.equal(await Bun.file(file).text(), "B C “keep”  \n");
  });
});
