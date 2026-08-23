import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preferDistExtensionEntries } from "../src/core/prefer-dist-extension-entries.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function agentWithPkg(name: string, manifest: object, files: Record<string, string>) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-prefer-dist-"));
  dirs.push(agentDir);
  const pkgDir = path.join(agentDir, "npm", "node_modules", name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(pkgDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return { agentDir, pkgDir };
}

describe("preferDistExtensionEntries", () => {
  test("rewrites src entry to dist when dist exists", () => {
    const { agentDir, pkgDir } = agentWithPkg(
      "pi-schedule-prompt",
      { pi: { extensions: ["./src/index.ts"] } },
      {
        "src/index.ts": "export default () => {}",
        "dist/index.js": "export default () => {}",
      },
    );
    const { rewritten } = preferDistExtensionEntries(agentDir);
    expect(rewritten).toEqual([pkgDir]);
    const data = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    expect(data.pi.extensions).toEqual(["./dist/index.js"]);
  });

  test("leaves src when dist is missing", () => {
    const { agentDir, pkgDir } = agentWithPkg(
      "only-src",
      { pi: { extensions: ["./src/index.ts"] } },
      { "src/index.ts": "export default () => {}" },
    );
    expect(preferDistExtensionEntries(agentDir).rewritten).toEqual([]);
    const data = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    expect(data.pi.extensions).toEqual(["./src/index.ts"]);
  });

  test("is idempotent when already dist", () => {
    const { agentDir, pkgDir } = agentWithPkg(
      "pi-schedule-prompt",
      { pi: { extensions: ["./dist/index.js"] } },
      { "dist/index.js": "export default () => {}" },
    );
    const before = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
    expect(preferDistExtensionEntries(agentDir).rewritten).toEqual([]);
    expect(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).toBe(before);
  });

  test("process memo skips second scan of same agentDir", () => {
    const { agentDir, pkgDir } = agentWithPkg(
      "pi-schedule-prompt",
      { pi: { extensions: ["./src/index.ts"] } },
      {
        "src/index.ts": "export default () => {}",
        "dist/index.js": "export default () => {}",
      },
    );
    expect(preferDistExtensionEntries(agentDir).rewritten).toEqual([pkgDir]);
    // Force src again; memo must prevent a second rewrite pass.
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      `${JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }, null, 2)}\n`,
    );
    expect(preferDistExtensionEntries(agentDir).rewritten).toEqual([]);
    const data = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    expect(data.pi.extensions).toEqual(["./src/index.ts"]);
  });
});
