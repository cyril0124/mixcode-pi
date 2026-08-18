import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import { createTab, MixCodeRuntime, renderChat } from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("chat renders user text without a role label and keeps tool/system content", () => {
  const user = stripAnsi(renderChat([{ role: "user", text: "hello" }], 40).join("\n"));
  assert.match(user, /hello/);
  assert.doesNotMatch(user, /\buser\b/);

  const mixed = stripAnsi(
    renderChat(
      [
        { role: "assistant", text: "agent reply" },
        { role: "tool", title: "bash", status: "success", text: "tool output", args: { command: "pwd" } },
        { role: "system", text: "system notice" },
      ],
      80,
    ).join("\n"),
  );
  assert.match(mixed, /agent reply/);
  assert.match(mixed, /\$ pwd/);
  assert.match(mixed, /tool output/);
  assert.match(mixed, /system notice/);
  assert.doesNotMatch(mixed, /\[System\]:/);
});

test("user-bash collapses long output and expands when toolsExpanded", () => {
  const tab = createTab(1, "s1", "/repo");
  const text = Array.from({ length: 25 }, (_, i) => `bash-line-${i}`).join("\n");
  const entry = {
    role: "tool" as const,
    title: "bash",
    variant: "user-bash" as const,
    status: "success" as const,
    text,
    args: { command: "printf lines" },
  };

  const collapsed = stripAnsi(renderChat([entry], 80).join("\n"));
  assert.match(collapsed, /\$ printf lines/);
  assert.doesNotMatch(collapsed, /bash-line-4\b/);
  assert.match(collapsed, /bash-line-5[\s\S]*bash-line-24/);
  assert.match(collapsed, /5 more lines/);

  const expanded = stripAnsi(
    renderChat([entry], 80, undefined, {
      ...tab,
      extensionUi: { ...tab.extensionUi, toolsExpanded: true },
    }).join("\n"),
  );
  assert.match(expanded, /bash-line-0[\s\S]*bash-line-24/);
});

test("chat strips terminal control sequences from tool output", () => {
  const rendered = renderChat(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        text: "\x1b]9;notify\x07osc\n\x1bPpayload\x1b\\dcs\n\x1b?literal",
        args: { command: "printf controls" },
      },
    ],
    80,
  ).join("\n");
  assert.match(stripAnsi(rendered), /osc[\s\S]*dcs[\s\S]*literal/);
  assert.doesNotMatch(rendered, /\x1b]9;notify\x07/);
  assert.doesNotMatch(rendered, /\x1bPpayload\x1b\\/);
});

test("assistant markdown renders structure without raw markers", () => {
  const plain = stripAnsi(
    renderChat(
      [
        {
          role: "assistant",
          text: ["# Title", "", "Use **bold** and `code`.", "", "- first item"].join("\n"),
        },
      ],
      40,
    ).join("\n"),
  );
  assert.match(plain, /Title/);
  assert.match(plain, /Use bold and code\./);
  assert.match(plain, /first item/);
  assert.doesNotMatch(plain, /\*\*bold\*\*/);
  assert.doesNotMatch(plain, /`code`/);
});

test("extension messages use custom renderers and fall back to text", () => {
  const plain = stripAnsi(
    renderChat(
      [
        { role: "extension", title: "extension note", customType: "note", text: "fallback text" },
        {
          role: "extension",
          title: "extension rendered",
          customType: "rendered",
          text: "raw text",
          renderExtension: () => ["rendered extension text"],
        },
        {
          role: "extension",
          title: "extension empty-render",
          customType: "empty-render",
          text: "fallback after empty render",
          renderExtension: () => [],
        },
      ],
      80,
    ).join("\n"),
  );
  assert.match(plain, /extension note/);
  assert.match(plain, /fallback text/);
  assert.match(plain, /rendered extension text/);
  assert.match(plain, /fallback after empty render/);
});

test("stable assistant markdown stays visible when only streaming text changes", () => {
  const stable = { role: "assistant" as const, text: "stable **history**" };
  const streaming = { role: "assistant" as const, text: "partial one" };
  renderChat([stable, streaming], 80);
  streaming.text = "partial two";
  const out = stripAnsi(renderChat([stable, streaming], 80).join("\n"));
  assert.match(out, /stable history/);
  assert.match(out, /partial two/);
});

test("edit tool results render old and new file content", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-edit-render-"));
  try {
    await fsPromises.writeFile(path.join(dir, "run.sh"), "echo old\n", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const editTool = runtimeTab.agentSession.agent.state.tools.find((tool) => tool.name === "edit");
    assert.ok(editTool);
    const args = {
      path: "run.sh",
      edits: [{ oldText: "echo old", newText: "echo new" }],
    };
    const result = await editTool.execute("tc-edit", args);
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_start",
      toolCallId: "tc-edit",
      toolName: "edit",
      args,
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "tc-edit",
      toolName: "edit",
      result,
      isError: false,
    });

    const plain = stripAnsi(renderChat(runtimeTab.chat, 100).join("\n"));
    assert.match(plain, /edit run\.sh/);
    assert.match(plain, /echo old/);
    assert.match(plain, /echo new/);
    assert.doesNotMatch(plain, /Successfully replaced/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
