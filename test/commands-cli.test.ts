import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  formatCommandCatalog,
  formatCommandUsage,
  isCommandsCliArgs,
  loadCommandCatalog,
  mergeCommandCatalog,
  parseCommandsArgs,
} from "../src/cli/commands-list.js";

test("isCommandsCliArgs and parseCommandsArgs", () => {
  assert.equal(isCommandsCliArgs(["commands"]), true);
  assert.equal(isCommandsCliArgs(["commands", "compact"]), true);
  assert.equal(isCommandsCliArgs(["ctl"]), false);
  assert.equal(parseCommandsArgs(["--json"], "/caller").json, true);
  assert.equal(parseCommandsArgs(["--workdir", "./rel"], "/caller").workdir, path.resolve("/caller", "./rel"));
  assert.equal(parseCommandsArgs(["--help"], "/caller").help, true);
  assert.throws(() => parseCommandsArgs(["--nope"], "/caller"), /Unknown commands argument/);
  assert.throws(() => parseCommandsArgs(["compact"], "/caller"), /Unexpected argument/);
});

test("mergeCommandCatalog prefers local names and formats usage", () => {
  const catalog = mergeCommandCatalog({
    local: [{ name: "compact", description: "Compact context" }, { name: "context-limit", description: "Set limit", argumentHint: "<tokens|reset>" }],
    extension: [
      { name: "compact", description: "extension compact" },
      { name: "commands", description: "Browse commands", path: "/ext/command-browser.ts" },
    ],
    prompt: [{ name: "review", description: "Review template", argumentHint: "<file>" }],
  });
  const byName = Object.fromEntries(catalog.map((entry) => [entry.name, entry]));
  assert.equal(byName.compact?.source, "local");
  assert.equal(byName.compact?.description, "Compact context");
  assert.equal(byName.compact?.usage, "/compact");
  assert.equal(byName["context-limit"]?.usage, "/context-limit <tokens|reset>");
  assert.equal(byName.commands?.source, "extension");
  assert.equal(byName.commands?.path, "/ext/command-browser.ts");
  assert.equal(byName.review?.usage, "/review <file>");
  assert.equal(byName["skill:mpi-ctl"], undefined);
  assert.match(formatCommandCatalog(catalog), /\/context-limit <tokens\|reset>\n  Set limit/);
});

test("loadCommandCatalog includes local and a fixture extension command", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-commands-agent-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-commands-wd-"));
  const extFile = path.join(agentDir, "probe-commands.ts");
  await fs.writeFile(
    extFile,
    `export default function (pi) {
  pi.registerCommand("probe-cmd", {
    description: "probe command",
    handler: async () => undefined,
  });
};
`,
  );
  try {
    const catalog = await loadCommandCatalog({
      workdir,
      agentDir,
      additionalExtensionPaths: [extFile],
    });
    const names = new Set(catalog.map((entry) => entry.name));
    assert.ok(names.has("compact"));
    assert.ok(names.has("help"));
    assert.ok(names.has("probe-cmd"));
    const probe = catalog.find((entry) => entry.name === "probe-cmd");
    assert.equal(probe?.source, "extension");
    assert.equal(probe?.path, extFile);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});
