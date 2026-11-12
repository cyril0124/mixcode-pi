import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  initTheme,
  SessionManager,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import toolDisplayExtension from "./index.js";
import { stripAllEscapes } from "./render-utils.js";

type RendererSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];

async function createRendererSession() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-tool-renderer-resolver-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const faux = createFauxCore({ models: [{ id: "renderer-test" }] });
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      extensionFactories: [toolDisplayExtension],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(dir),
  });
  await session.bindExtensions({ mode: "print" });

  const dispose = async () => {
    session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { dir, session, dispose };
}

function renderTool(
  session: RendererSession,
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
  result: { text: string; details?: unknown; durationMs?: number },
  base?: ToolRenderers,
): string {
  const definition = session.extensionRunner.resolveToolRenderers(
    toolName,
    () => base ?? session.getToolDefinition(toolName),
  );
  const component = new ToolExecutionComponent(
    toolName,
    `${toolName}-call`,
    args,
    { showImages: false, imageWidthCells: 20 },
    definition,
    { requestRender: () => undefined } as never,
    cwd,
  );
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult(
    {
      content: [{ type: "text", text: result.text }],
      details: result.details,
      isError: false,
      durationMs: result.durationMs,
    },
    false,
  );
  return stripAllEscapes(component.render(140).join("\n"));
}

test("uses the public renderer resolver without patching ToolExecutionComponent", async () => {
  initTheme("dark");
  const prototype = ToolExecutionComponent.prototype as unknown as Record<string, unknown>;
  const nativeCallSelector = Object.getOwnPropertyDescriptor(prototype, "getCallRenderer")?.value;
  const nativeResultSelector = Object.getOwnPropertyDescriptor(
    prototype,
    "getResultRenderer",
  )?.value;
  const { dir, session, dispose } = await createRendererSession();
  try {
    assert.equal(
      Object.getOwnPropertyDescriptor(prototype, "getCallRenderer")?.value,
      nativeCallSelector,
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(prototype, "getResultRenderer")?.value,
      nativeResultSelector,
    );

    const editRenderers = session.extensionRunner.resolveToolRenderers("edit", () => ({
      renderShell: "self",
    }));
    assert.equal(editRenderers?.renderShell, "default");

    const native = renderTool(
      session,
      dir,
      "native_tool",
      { payload: "hidden" },
      { text: "native result" },
      { renderCall: () => ({ render: () => ["native call"], invalidate: () => undefined }) },
    );
    assert.match(native, /native call/);
    assert.match(native, /native result/);
    assert.doesNotMatch(native, /"payload"/);

    const unknownOutput = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
    const unknown = renderTool(
      session,
      dir,
      "unknown_tool",
      { raw: "hidden" },
      { text: unknownOutput },
    );
    assert.match(unknown, /unknown_tool/);
    assert.match(unknown, /line-12/);
    assert.doesNotMatch(unknown, /"raw"/);
  } finally {
    await dispose();
  }
});

test("uses configured expand keys and Pi's recorded duration through the real tool row", async () => {
  initTheme("dark");
  const hostTui = await import("../../vendor/pi/packages/tui/dist/index.js");
  const previousKeybindings = hostTui.getKeybindings();
  // The installed coding-agent resolves this host TUI instance through its nested symlink.
  hostTui.setKeybindings(
    new hostTui.KeybindingsManager(
      {
        ...hostTui.TUI_KEYBINDINGS,
        "app.tools.expand": { defaultKeys: "ctrl+o" },
      },
      { "app.tools.expand": "alt+x" },
    ),
  );
  const { dir, session, dispose } = await createRendererSession();
  try {
    const bash = renderTool(
      session,
      dir,
      "bash",
      { command: "echo done", description: "Print the result" },
      { text: "done", durationMs: 65_000 },
    );
    assert.match(bash, /ok · 1m 5s · 1 line · alt\+x/);
    assert.doesNotMatch(bash, /ctrl\+o/i);

    const read = renderTool(
      session,
      dir,
      "read",
      { path: "src/example.ts" },
      { text: "one\ntwo\nthree" },
    );
    assert.match(read, /alt\+x to expand/);
    assert.doesNotMatch(read, /ctrl\+o/i);

    const addedLines = Array.from({ length: 30 }, (_, index) => `+line ${index + 1}`);
    const diff = ["@@ -0,0 +1,30 @@", ...addedLines].join("\n");
    const edit = renderTool(
      session,
      dir,
      "edit",
      { path: "src/example.ts", edits: [{ oldText: "", newText: "new" }] },
      { text: "ok", details: { diff, patch: "" } },
    );
    assert.match(edit, /alt\+x to expand/);
    assert.doesNotMatch(edit, /ctrl\+o/i);
  } finally {
    await dispose();
    hostTui.setKeybindings(previousKeybindings);
  }
});
