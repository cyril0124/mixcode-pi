import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILENAME } from "./config.js";
import commandRouterExtension from "./index.js";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const previousAgentDir = process.env[AGENT_DIR_ENV];
const directories: string[] = [];

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
  else process.env[AGENT_DIR_ENV] = previousAgentDir;
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

interface TestCommandContext {
  cwd: string;
  isProjectTrusted(): boolean;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

type CommandHandler = (args: string, ctx: TestCommandContext) => Promise<void>;
type Notification = { message: string; type?: "info" | "warning" | "error" };

const readEnabled = async (filename: string) =>
  JSON.parse(await fs.readFile(filename, "utf8")).enabled;

/** Registers the extension against a temporary agent directory and captures its notifications. */
async function harness(trusted = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-router-command-"));
  directories.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  process.env[AGENT_DIR_ENV] = agentDir;

  let handler: CommandHandler | undefined;
  const notifications: Notification[] = [];
  const pi = {
    registerCommand: (_name: string, options: { handler: CommandHandler }) => {
      handler = options.handler;
    },
    on: () => {},
  } as unknown as ExtensionAPI;
  commandRouterExtension(pi);
  assert.ok(handler, "the extension must register the command-router command");
  const commandHandler = handler;

  const ctx: TestCommandContext = {
    cwd,
    isProjectTrusted: () => trusted,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  };

  return {
    globalConfig: path.join(agentDir, CONFIG_FILENAME),
    projectConfig: path.join(cwd, ".pi", CONFIG_FILENAME),
    run: async (args: string) => {
      notifications.length = 0;
      await commandHandler(args, ctx);
      assert.equal(notifications.length, 1, "every invocation must report exactly one result");
      return notifications[0]!;
    },
  };
}

test("a layer toggle keeps its schema and raw routes and reports the skipped layer", async () => {
  const f = await harness();
  const routes = { demo: ["$HOME/demo script", "--from-router"] };
  await fs.writeFile(
    f.globalConfig,
    `${JSON.stringify({ $schema: "./router.schema.json", routes }, null, 2)}\n`,
  );

  const off = await f.run("off --global");
  assert.match(off.message, /^Routing off: global disabled — /);
  assert.doesNotMatch(off.message, /project/, "--global must not touch the project layer");
  const disabled = JSON.parse(await fs.readFile(f.globalConfig, "utf8"));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.$schema, "./router.schema.json");
  assert.deepEqual(
    disabled.routes,
    routes,
    "a write must not bake expanded environment values into the file",
  );

  const on = await f.run("on");
  assert.match(on.message, /^Routing on: global enabled — /);
  assert.match(on.message, /; project skipped \(no config file\)$/);
  assert.equal(await readEnabled(f.globalConfig), true);
  await assert.rejects(fs.stat(f.projectConfig), { code: "ENOENT" });
});

test("the default toggle covers both existing layers and --project creates a missing one", async () => {
  const f = await harness();
  await fs.writeFile(
    f.globalConfig,
    JSON.stringify({ enabled: true, routes: { demo: ["target"] } }),
  );
  await fs.writeFile(f.projectConfig, JSON.stringify({ enabled: true, routes: {} }));

  const off = await f.run("off");
  assert.match(off.message, /^Routing off: global disabled — /);
  assert.match(off.message, /; project disabled — .*mpi-command-router\.json$/);
  assert.equal(await readEnabled(f.globalConfig), false);
  assert.equal(await readEnabled(f.projectConfig), false);

  const on = await f.run("on");
  assert.match(on.message, /^Routing on: global enabled — /);
  assert.match(on.message, /; project enabled — /);
  assert.equal(await readEnabled(f.projectConfig), true);

  const created = await f.run("off --project");
  assert.match(created.message, /^Routing off: project disabled — /);
  assert.equal(await readEnabled(f.projectConfig), false);
  assert.equal(await readEnabled(f.globalConfig), true, "--project must not touch the user layer");
});

test("a single-layer toggle reports the other layer that still blocks routing", async () => {
  const f = await harness();
  await fs.writeFile(
    f.globalConfig,
    JSON.stringify({ enabled: false, routes: { demo: ["target"] } }),
  );
  await fs.writeFile(f.projectConfig, JSON.stringify({ enabled: true, routes: {} }));

  const on = await f.run("on --project");
  assert.match(on.message, /^Routing on: project enabled — /);
  assert.match(on.message, /; still off: global layer off \(1 route\)$/);
  assert.equal(await readEnabled(f.globalConfig), false);
});

test("status reports both layers, an untrusted project, and an unreadable layer", async () => {
  const f = await harness();
  await fs.writeFile(
    f.globalConfig,
    JSON.stringify({ enabled: true, routes: { demo: ["target"] } }),
  );
  await fs.writeFile(f.projectConfig, JSON.stringify({ enabled: false, routes: {} }));

  const status = await f.run("");
  assert.match(status.message, /^Routing off: global on \(1 route\) — /);
  assert.match(status.message, /project off \(0 routes\) — /);

  const untrusted = await harness(false);
  const skipped = await untrusted.run("off");
  assert.match(skipped.message, /; project skipped \(project not trusted\)$/);
  assert.equal(await readEnabled(untrusted.globalConfig), false);
  assert.match((await untrusted.run("")).message, /project ignored \(project not trusted\)/);
});

test("invalid usage, an invalid config and an untrusted --project fail without writing", async () => {
  const untrusted = await harness(false);
  const refused = await untrusted.run("off --project");
  assert.equal(refused.type, "error");
  assert.match(refused.message, /^Error: --project requires a trusted project$/);
  await assert.rejects(fs.stat(untrusted.projectConfig), { code: "ENOENT" });

  const f = await harness();
  for (const args of ["bogus", "on off", "on --global --project", "status --global"]) {
    const usage = await f.run(args);
    assert.equal(usage.type, "error", `${args} must be rejected`);
    assert.match(
      usage.message,
      /^Error: Usage: \/command-router \[on\|off\] \[--global\|--project\]$/,
      `${args} must be rejected`,
    );
  }
  await assert.rejects(fs.stat(f.globalConfig), { code: "ENOENT" });

  await fs.writeFile(f.globalConfig, "{");
  const invalid = await f.run("off");
  assert.equal(invalid.type, "error");
  assert.match(invalid.message, /^Error: .*mpi-command-router\.json: /);
  assert.equal(await fs.readFile(f.globalConfig, "utf8"), "{");
});
