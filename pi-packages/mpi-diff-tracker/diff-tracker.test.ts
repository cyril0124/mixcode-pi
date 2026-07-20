import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  detectDiffnavCommand,
  formatDownloadProgress,
  isAllowedAssetUrl,
  parseDiffnavVersionOutput,
  parseHunks,
  pickDeltaReleaseAsset,
  pickReleaseAsset,
  platformAssetName,
  deltaAssetTarget,
  resolveDeltaBinary,
  viewerPathEnv,
  resetDiffnavInstallStateForTests,
  reversePatch,
} from "./index.js";

test("reversePatch: full-file pure deletion reconstructs old content", () => {
  // Pi generateUnifiedPatch(old="hello\nworld\n", new="") shape.
  const patch = ["--- f.txt", "+++ f.txt", "@@ -1,2 +0,0 @@", "-hello", "-world", ""].join("\n");
  const initial = reversePatch("", parseHunks(patch));
  assert.equal(initial, "hello\nworld\n");
});

test("reversePatch: pure deletion with zero context inserts at newStart", () => {
  // contextLines=0 deletion of trailing lines: @@ -2,2 +1,0 @@
  const patch = ["@@ -2,2 +1,0 @@", "-line2", "-line3", ""].join("\n");
  const initial = reversePatch("keep\n", parseHunks(patch));
  assert.equal(initial, "keep\nline2\nline3\n");
});

test("reversePatch: still skips superseded non-empty new-side hunks", () => {
  // new-side "gone" is absent from final content → skip (later edit overwrote it)
  const patch = ["@@ -1,1 +1,1 @@", "-old", "+gone", ""].join("\n");
  const initial = reversePatch("other\n", parseHunks(patch));
  assert.equal(initial, "other\n");
});

test("reversePatch: normal contextual deletion still reverses by content", () => {
  const patch = ["@@ -1,3 +1,2 @@", " prefix", "-middle", " suffix", ""].join("\n");
  const initial = reversePatch("prefix\nsuffix\n", parseHunks(patch));
  assert.equal(initial, "prefix\nmiddle\nsuffix\n");
});

test("platformAssetName maps linux/darwin common arch", () => {
  assert.equal(platformAssetName("linux", "x64"), "Linux_x86_64");
  assert.equal(platformAssetName("linux", "arm64"), "Linux_arm64");
  assert.equal(platformAssetName("darwin", "x64"), "Darwin_x86_64");
  assert.equal(platformAssetName("darwin", "arm64"), "Darwin_arm64");
  assert.equal(platformAssetName("win32", "x64"), null);
  assert.equal(platformAssetName("linux", "ia32"), null);
});

test("isAllowedAssetUrl accepts github release tar.gz only", () => {
  assert.equal(
    isAllowedAssetUrl(
      "https://github.com/dlvhdr/diffnav/releases/download/v0.11.0/diffnav_0.11.0_Linux_x86_64.tar.gz",
    ),
    true,
  );
  assert.equal(
    isAllowedAssetUrl(
      "https://github.com/dlvhdr/diffnav/releases/download/v0.11.0/diffnav_0.11.0_Windows_x86_64.zip",
    ),
    false,
  );
  assert.equal(isAllowedAssetUrl("https://example.com/diffnav.tar.gz"), false);
  assert.equal(isAllowedAssetUrl("https://github.com/dlvhdr/diffnav/archive/refs/tags/v0.11.0.tar.gz"), false);
  assert.equal(isAllowedAssetUrl("not-a-url"), false);
});

test("formatDownloadProgress uses bar when total known", () => {
  const text = formatDownloadProgress(1500, 3000);
  assert.match(text, /diffnav \[/);
  assert.match(text, /50%/);
  assert.match(text, /\//);
});

test("formatDownloadProgress uses spinner when total unknown", () => {
  const text = formatDownloadProgress(100_000, null);
  assert.match(text, /diffnav \[/);
  assert.doesNotMatch(text, /%/);
});

test("pickReleaseAsset matches versioned and unversioned asset names", () => {
  const versioned = pickReleaseAsset(
    {
      tag_name: "v0.11.0",
      assets: [
        {
          name: "diffnav_0.11.0_Linux_x86_64.tar.gz",
          size: 1,
          browser_download_url:
            "https://github.com/dlvhdr/diffnav/releases/download/v0.11.0/diffnav_0.11.0_Linux_x86_64.tar.gz",
        },
      ],
    },
    "Linux_x86_64",
  );
  assert.equal(versioned?.assetName, "diffnav_0.11.0_Linux_x86_64.tar.gz");

  const unversioned = pickReleaseAsset(
    {
      tag_name: "v0.11.0",
      assets: [
        {
          name: "diffnav_Linux_x86_64.tar.gz",
          size: 3181392,
          browser_download_url:
            "https://github.com/dlvhdr/diffnav/releases/download/v0.11.0/diffnav_Linux_x86_64.tar.gz",
        },
      ],
    },
    "Linux_x86_64",
  );
  assert.equal(unversioned?.assetName, "diffnav_Linux_x86_64.tar.gz");
  assert.equal(pickReleaseAsset({ tag_name: "v0.11.0", assets: [] }, "Linux_x86_64"), null);
});

test("deltaAssetTarget maps common platforms", () => {
  assert.equal(deltaAssetTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(deltaAssetTarget("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(deltaAssetTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(deltaAssetTarget("win32", "x64"), null);
});

test("pickDeltaReleaseAsset matches rustc target names", () => {
  const asset = pickDeltaReleaseAsset(
    {
      tag_name: "0.19.2",
      assets: [
        {
          name: "delta-0.19.2-x86_64-unknown-linux-gnu.tar.gz",
          size: 1,
          browser_download_url:
            "https://github.com/dandavison/delta/releases/download/0.19.2/delta-0.19.2-x86_64-unknown-linux-gnu.tar.gz",
        },
      ],
    },
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(asset?.assetName, "delta-0.19.2-x86_64-unknown-linux-gnu.tar.gz");
});

test("viewerPathEnv prefixes diffnav and local bin dirs", () => {
  const path = viewerPathEnv("/opt/tools/diffnav", "/usr/bin");
  assert.match(path, /^\/opt\/tools:/);
  assert.match(path, /\.local\/bin/);
  assert.match(path, /:\/usr\/bin$/);
});

test("resolveDeltaBinary finds sibling of diffnav", () => {
  const dir = mkdtempSync(join(tmpdir(), "delta-sib-"));
  try {
    const delta = join(dir, "delta");
    const diffnav = join(dir, "diffnav");
    writeFileSync(delta, "x");
    writeFileSync(diffnav, "x");
    chmodSync(delta, 0o755);
    assert.equal(resolveDeltaBinary(diffnav), delta);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseDiffnavVersionOutput ignores logo and reads version line", () => {
  const raw = [
    "\u001b[32m▜▔▚ ▌▐▔▔▐▔▔\u001b[m\u001b[31m▐▚ ▌▐▔▌▐ ▞\u001b[m",
    "\u001b[32m▟▁▞ ▌▐▔ ▐▔ \u001b[m\u001b[31m▐ ▚▌▐▔▌▐▞ \u001b[m",
    "version v0.11.0",
    "",
  ].join("\n");
  assert.equal(parseDiffnavVersionOutput(raw), "v0.11.0");
});

test("detectDiffnavCommand prefers PATH then installed path", () => {
  resetDiffnavInstallStateForTests();
  assert.equal(detectDiffnavCommand({ whichPath: "/usr/bin/diffnav", useCache: false }), "/usr/bin/diffnav");

  resetDiffnavInstallStateForTests();
  const dir = mkdtempSync(join(tmpdir(), "diffnav-detect-"));
  const bin = join(dir, "diffnav");
  try {
    writeFileSync(bin, "#!/bin/sh\necho ok\n");
    chmodSync(bin, 0o755);
    assert.equal(detectDiffnavCommand({ whichPath: null, installedPath: bin, useCache: false }), bin);
    assert.equal(
      detectDiffnavCommand({ whichPath: null, installedPath: join(dir, "missing"), useCache: false }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
