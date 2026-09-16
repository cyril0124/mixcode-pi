import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { CommandRouter } from "./router.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-router-test-"));
  directories.push(root);
  const agentDir = path.join(root, "agent ' files");
  const projectDir = path.join(root, "project");
  const projectConfigDir = path.join(projectDir, ".pi");
  const bin = path.join(root, "bin");
  await fs.mkdir(agentDir);
  await fs.mkdir(projectConfigDir, { recursive: true });
  await fs.mkdir(bin);
  const configPath = path.join(agentDir, "mpi-command-router.json");
  const configure = (routes: Record<string, string[]>, enabled = true) =>
    fs.writeFile(configPath, JSON.stringify({ enabled, routes }));
  const configureProject = (routes: Record<string, string[]>, enabled = true) =>
    fs.writeFile(
      path.join(projectConfigDir, "mpi-command-router.json"),
      JSON.stringify({ enabled, routes }),
    );
  const scriptAt = async (directory: string, name: string, body: string) => {
    const filename = path.join(directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return filename;
  };
  const scope = { cwd: projectDir, projectTrusted: true };
  return {
    root,
    agentDir,
    projectDir,
    projectConfigDir,
    bin,
    configPath,
    configure,
    configureProject,
    scope,
    script: (name: string, body: string) => scriptAt(bin, name, body),
    scriptAt,
    router: new CommandRouter(agentDir, ".pi"),
  };
}

function run(command: string, cwd: string, bin: string, input = "") {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      stdio: "pipe",
      timeout: 5000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

test("missing, empty and disabled configurations leave commands untouched", async () => {
  const f = await fixture();
  const command = "printf '%s' untouched";
  assert.equal(await f.router.prepare(command), command);
  await f.configure({});
  assert.equal(await f.router.prepare(command), command);
  await f.configure({ demo: ["missing"] }, false);
  assert.equal(await f.router.prepare(command), command);
  assert.deepEqual(await fs.readdir(f.agentDir), ["mpi-command-router.json"]);
});

test("routes fixed and original arguments literally while preserving cwd and environment", async () => {
  const f = await fixture();
  const target = await f.script(
    "target ' script",
    'printf "%s\\n" "$PWD" "$ROUTER_TEST_VALUE" "$@"',
  );
  await f.configure({ demo: [target, "fixed ' value", "$(touch injected)", ""] });
  const command = await f.router.prepare(
    "ROUTER_TEST_VALUE=present demo 'two words' '' '; echo bad' '*.ts'",
  );
  const result = await run(command, f.root, f.bin);
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    `${f.root}\npresent\nfixed ' value\n$(touch injected)\n\ntwo words\n\n; echo bad\n*.ts\n`,
  );
  await assert.rejects(fs.stat(path.join(f.root, "injected")), { code: "ENOENT" });
});

test("preserves pipes, stdin, stderr, redirection and nonzero exit status", async () => {
  const f = await fixture();
  const target = await f.script("target", 'cat; printf "diagnostic" >&2; exit 23');
  await f.configure({ demo: [target] });
  const result = await run(await f.router.prepare("demo > result.txt"), f.root, f.bin, "payload");
  assert.deepEqual(result, { stdout: "", stderr: "diagnostic", code: 23 });
  assert.equal(await fs.readFile(path.join(f.root, "result.txt"), "utf8"), "payload");
  const pipeline = await run(await f.router.prepare("printf payload | demo | cat"), f.root, f.bin);
  assert.equal(pipeline.stdout, "payload");
  assert.equal(pipeline.stderr, "diagnostic");
  assert.equal(pipeline.code, 0);
});

test("named targets resolve against the original PATH and children inherit routing", async () => {
  const f = await fixture();
  await f.script("target", 'printf "routed:%s\\n" "$1"');
  await f.script("demo", 'printf "original"');
  await f.configure({ demo: ["target"] });
  const result = await run(
    await f.router.prepare("sh -c 'demo child'; demo parent"),
    f.root,
    f.bin,
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "routed:child\nrouted:parent\n");
});

test("target scripts can call the original executable through its absolute path", async () => {
  const f = await fixture();
  await f.script("demo", 'printf "original:%s" "$1"');
  const target = await f.script(
    "target",
    'printf "%s:" "$MPI_COMMAND_ROUTER_COMMAND"; exec "$MPI_COMMAND_ROUTER_ORIGINAL" "$@"',
  );
  await f.configure({ demo: [target] });
  const result = await run(await f.router.prepare("demo argument"), f.root, f.bin);
  assert.deepEqual(result, { stdout: "demo:original:argument", stderr: "", code: 0 });
});

test("same-name targets execute the original rather than recursively entering their wrapper", async () => {
  const f = await fixture();
  await f.script("demo", 'printf "%s\\n" "$@"');
  await f.configure({ demo: ["demo", "fixed"] });
  const result = await run(await f.router.prepare("demo argument"), f.root, f.bin);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "fixed\nargument\n");
});

test("recursive scripts fail with an actionable error instead of spawning indefinitely", async () => {
  const f = await fixture();
  const target = await f.script("target", "exec demo");
  await f.configure({ demo: [target] });
  const result = await run(await f.router.prepare("demo"), f.root, f.bin);
  assert.equal(result.code, 126);
  assert.match(result.stderr, /^Error:.*recursive.*demo.*MPI_COMMAND_ROUTER_ORIGINAL/);
});

test("relative script targets are relative to the config directory, not the tool cwd", async () => {
  const f = await fixture();
  await f.script("target", "printf relative");
  await f.configure({ demo: ["../bin/target"] });
  const result = await run(await f.router.prepare("cd /; demo"), f.root, f.bin);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "relative");
});

test("configuration changes preserve older prepared commands and isolate parallel instances", async () => {
  const f = await fixture();
  const target = await f.script("target", 'printf "%s" "$1"');
  const otherRouter = new CommandRouter(f.agentDir, ".pi");
  const environment = { ...process.env };
  await f.configure({ demo: [target, "old"] });
  const oldCommands = await Promise.all([f.router.prepare("demo"), otherRouter.prepare("demo")]);
  await f.configure({ demo: [target, "new"] });
  const newCommand = await f.router.prepare("demo");
  const results = await Promise.all(
    [...oldCommands, newCommand].map((cmd) => run(cmd, f.root, f.bin)),
  );
  assert.deepEqual(
    results.map((r) => [r.code, r.stdout]),
    [
      [0, "old"],
      [0, "old"],
      [0, "new"],
    ],
  );
  assert.deepEqual(process.env, environment);
  await f.configure({});
  assert.equal(await f.router.prepare("demo"), "demo");
});

test("invalid configuration fails explicitly and recovers after a valid edit", async () => {
  const f = await fixture();
  const invalid: Array<[string, RegExp]> = [
    ["{", /JSON/],
    ["null", /expected an object/],
    ["[]", /expected an object/],
    ['{"routes":{},"typo":true}', /unknown setting: typo/],
    ['{"enabled":"yes","routes":{}}', /enabled must be a boolean/],
    ['{"routes":[]}', /routes must be an object/],
    ['{"routes":{"../demo":["target"]}}', /invalid command name/],
    ['{"routes":{"demo":[]}}', /nonempty string array/],
    ['{"routes":{"demo":"target"}}', /nonempty string array/],
    ['{"routes":{"demo":[""]}}', /nonempty executable/],
    ['{"routes":{"demo":["target",1]}}', /nonempty string array/],
    ['{"routes":{"demo":["target","\\u0000"]}}', /nonempty executable and no NUL bytes/],
    ['{"$schema":1,"routes":{}}', /\$schema must be a string/],
    ["{}", /routes must be an object/],
    // `\${` keeps the unclosed reference literal for the config while satisfying lint.
    [`{"routes":{"demo":["\${UNCLOSED"]}}`, /invalid environment reference/],
  ];
  for (const [text, expected] of invalid) {
    await fs.writeFile(f.configPath, text);
    await assert.rejects(f.router.prepare("demo"), (error: unknown) => {
      assert.ok(error instanceof Error);
      // Failures must carry the standard prefix and name the offending file.
      assert.ok(error.message.startsWith(`Error: ${f.configPath}: `), error.message);
      return expected.test(error.message);
    });
  }
  await f.configure({});
  assert.equal(await f.router.prepare("demo"), "demo");
});

test("missing targets fail with command-not-found status and identify the route", async () => {
  const f = await fixture();
  await f.configure({ demo: ["no-such-router-target"] });
  const result = await run(await f.router.prepare("demo"), f.root, f.bin);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /^Error:.*demo.*no-such-router-target/);
});

test("expands environment references in targets and fixed arguments on every call", async () => {
  const f = await fixture();
  const first = path.join(f.root, "first");
  const second = path.join(f.root, "second");
  for (const [dir, marker] of [
    [first, "first"],
    [second, "second"],
  ] as const) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "target"), `#!/bin/sh\nprintf '${marker}:%s\\n' "$*"\n`, {
      mode: 0o700,
    });
  }
  process.env.ROUTER_TEST_DIR = first;
  process.env.ROUTER_TEST_SUFFIX = "one";
  try {
    // `\${` keeps the braced reference literal for the config while satisfying lint.
    await f.configure({
      demo: ["$ROUTER_TEST_DIR/target", `\${ROUTER_TEST_SUFFIX}`, "$$LITERAL"],
    });
    const firstCommand = await f.router.prepare("demo arg");
    assert.equal((await run(firstCommand, f.root, f.bin)).stdout, "first:one $LITERAL arg\n");

    process.env.ROUTER_TEST_DIR = second;
    process.env.ROUTER_TEST_SUFFIX = "two";
    const secondCommand = await f.router.prepare("demo arg");
    assert.equal((await run(secondCommand, f.root, f.bin)).stdout, "second:two $LITERAL arg\n");

    // Each prepared command keeps the expansion captured at its own call.
    assert.equal((await run(firstCommand, f.root, f.bin)).stdout, "first:one $LITERAL arg\n");
  } finally {
    delete process.env.ROUTER_TEST_DIR;
    delete process.env.ROUTER_TEST_SUFFIX;
  }
});

test("an undefined environment variable rejects the config instead of expanding to empty", async () => {
  const f = await fixture();
  const previous = process.env.ROUTER_TEST_MISSING;
  delete process.env.ROUTER_TEST_MISSING;
  try {
    await f.configure({ demo: ["$ROUTER_TEST_MISSING/target"] });
    await assert.rejects(
      f.router.prepare("demo"),
      /Error:.*mpi-command-router\.json: routes\.demo\[0\]: undefined environment variable \$ROUTER_TEST_MISSING/,
    );
    await f.configure({});
    assert.equal(await f.router.prepare("demo"), "demo");
  } finally {
    if (previous !== undefined) process.env.ROUTER_TEST_MISSING = previous;
  }
});

test("a second router reuses the published wrapper directory", async () => {
  const f = await fixture();
  await f.script("target", 'printf "reused:%s" "$*"');
  await f.configure({ demo: ["target"] });
  await f.router.prepare("demo one");
  const cache = path.join(f.agentDir, "cache", "mpi-command-router");
  const published = await fs.readdir(cache);

  // A fresh instance has no in-memory hash, so it must find the directory on disk.
  const second = await new CommandRouter(f.agentDir, ".pi").prepare("demo two");
  assert.deepEqual(await fs.readdir(cache), published);
  assert.equal((await run(second, f.root, f.bin)).stdout, "reused:two");
});

test("an abandoned staging directory is pruned while published directories are kept", async () => {
  const f = await fixture();
  await f.script("target", 'printf "ok"');
  await f.configure({ demo: ["target"] });
  await f.router.prepare("demo");
  const cache = path.join(f.agentDir, "cache", "mpi-command-router");
  const published = await fs.readdir(cache);
  const [publishedName] = published;
  assert.ok(publishedName);
  const marker = path.join(cache, publishedName, "marker");
  await fs.writeFile(marker, "kept");

  const crashedStaging = path.join(cache, ".prepare-crashed");
  const publishedName2 = "0".repeat(64);
  const olderPublished = path.join(cache, publishedName2);
  await fs.mkdir(crashedStaging);
  await fs.mkdir(olderPublished);
  const old = new Date("2000-01-01T00:00:00.000Z");
  await fs.utimes(crashedStaging, old, old);
  await fs.utimes(olderPublished, old, old);

  await new CommandRouter(f.agentDir, ".pi").prepare("demo");

  // Staging residue goes; published wrappers stay usable whatever their age.
  assert.deepEqual((await fs.readdir(cache)).sort(), [...published, publishedName2].sort());
  assert.equal(await fs.readFile(marker, "utf8"), "kept");
});

test("an empty expansion is rejected as an executable and kept as an argument", async () => {
  const f = await fixture();
  process.env.ROUTER_TEST_EMPTY = "";
  try {
    await f.configure({ demo: ["$ROUTER_TEST_EMPTY"] });
    await assert.rejects(f.router.prepare("demo"), /Error:.*nonempty executable/);

    const target = await f.script("target", 'printf "[%s]" "$@"');
    await f.configure({ demo: [target, "$ROUTER_TEST_EMPTY"] });
    const result = await run(await f.router.prepare("demo"), f.root, f.bin);
    assert.deepEqual(result, { stdout: "[]", stderr: "", code: 0 });
  } finally {
    delete process.env.ROUTER_TEST_EMPTY;
  }
});

test("a trusted project config overrides global routes and adds its own", async () => {
  const f = await fixture();
  const globalTarget = await f.script("global-target", 'printf "global:%s" "$*"');
  await f.configure({
    overridden: [globalTarget, "global"],
    "global-only": [globalTarget, "only"],
  });
  await f.scriptAt(f.projectConfigDir, "routes/project-target", 'printf "project:%s" "$*"');
  await f.configureProject({ overridden: ["routes/project-target"] });

  const command = await f.router.prepare("overridden a; global-only b", f.scope);
  const result = await run(command, f.projectDir, f.bin);
  // The project target resolves against <cwd>/.pi, the global one against agentDir.
  assert.equal(result.stdout, "project:aglobal:only b");
});

test("an untrusted project contributes no routes", async () => {
  const f = await fixture();
  await f.scriptAt(f.projectConfigDir, "routes/project-target", 'printf "project"');
  await f.configureProject({ demo: ["routes/project-target"] });

  const untrusted = { ...f.scope, projectTrusted: false };
  assert.equal(await f.router.prepare("demo", untrusted), "demo");
  const result = await run(await f.router.prepare("demo", f.scope), f.projectDir, f.bin);
  assert.equal(result.stdout, "project");
});

test("a project config alone routes when no global config exists", async () => {
  const f = await fixture();
  await f.scriptAt(f.projectConfigDir, "routes/project-target", 'printf "project-only"');
  await f.configureProject({ demo: ["routes/project-target"] });

  const result = await run(await f.router.prepare("demo", f.scope), f.projectDir, f.bin);
  assert.equal(result.stdout, "project-only");
});

test("routing runs only when every present layer is enabled", async () => {
  const f = await fixture();
  const target = await f.script("target", 'printf "routed"');
  const projectTarget = await f.scriptAt(
    f.projectConfigDir,
    "routes/project-target",
    'printf "project"',
  );

  await f.configure({ demo: [target] }, false);
  await f.configureProject({ demo: [projectTarget] }, true);
  assert.equal(await f.router.prepare("demo", f.scope), "demo");

  await f.configure({ demo: [target] }, true);
  await f.configureProject({ demo: [projectTarget] }, false);
  assert.equal(await f.router.prepare("demo", f.scope), "demo");

  await f.configureProject({ demo: [projectTarget] }, true);
  assert.equal(
    (await run(await f.router.prepare("demo", f.scope), f.projectDir, f.bin)).stdout,
    "project",
  );
});

test("a broken project config blocks only while the project is trusted", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.projectConfigDir, "mpi-command-router.json"), "{");

  const untrusted = { ...f.scope, projectTrusted: false };
  assert.equal(await f.router.prepare("demo", untrusted), "demo");
  await assert.rejects(f.router.prepare("demo", f.scope), /\.pi\/mpi-command-router\.json/);
});

test("absolute calls bypass routing and targets without originals receive an empty original path", async () => {
  const f = await fixture();
  const original = await f.script("demo", "printf original");
  const target = await f.script("target", 'printf "routed:%s" "$MPI_COMMAND_ROUTER_ORIGINAL"');
  await f.configure({ demo: [target], invented: [target] });
  const result = await run(await f.router.prepare(`${original}; invented`), f.root, f.bin);
  assert.deepEqual(result, { stdout: "originalrouted:", stderr: "", code: 0 });
});
