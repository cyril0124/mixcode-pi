import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { disposeAll, resetDisposed } from "./disposable.js";
import toolDisplayExtension, { createToolDisplayRenderers } from "./index.js";

type RenderResult = { render(width: number): string[] };

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

let workDir: string;
before(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-tool-display-work-"));
});
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function renderLines(component: unknown, width: number): string[] {
	return (component as RenderResult).render(width).map(stripAnsi);
}

function textResult(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details } as never;
}

const collapsed = { expanded: false, isPartial: false } as never;
const expanded = { expanded: true, isPartial: false } as never;

function renderContext(overrides: Record<string, unknown> = {}) {
	return { state: {}, isError: false, ...overrides } as never;
}

test("extension never registers or replaces tools", () => {
	let registerToolCalls = 0;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerTool: () => {
			registerToolCalls += 1;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	} as unknown as ExtensionAPI;

	toolDisplayExtension(pi);
	assert.equal(registerToolCalls, 0);

	for (const handler of handlers.get("session_shutdown") ?? []) {
		void handler({ reason: "reload" }, {});
	}
});

test("bash spinner matches spinner running-state contract", () => {
	resetDisposed();
	const { bash } = createToolDisplayRenderers();
	const state: Record<string, unknown> = {};
	const component = bash.renderCall(
		{ command: "sleep 5", timeout: 30 } as never,
		theme,
		renderContext({
			toolCallId: "spinner-call",
			state,
			executionStarted: true,
			isPartial: true,
			invalidate: () => {},
		}),
	);
	const rendered = renderLines(component, 200).join("\n").trim();
	assert.match(rendered, /^⠋ \$ sleep 5 \(timeout 30s\) · 0s$/);

	// Rendering the completed state clears the timer and spinner.
	const completed = bash.renderCall(
		{ command: "sleep 5", timeout: 30 } as never,
		theme,
		renderContext({
			toolCallId: "spinner-call",
			state,
			executionStarted: true,
			isPartial: false,
			invalidate: () => {},
		}),
	);
	assert.equal(renderLines(completed, 200).join("\n").trim(), "$ sleep 5 (timeout 30s)");
	disposeAll();
});

test("bash result stays expanded while partial and collapses only when complete", () => {
	const { bash } = createToolDisplayRenderers();
	const result = textResult("live-one\nlive-two");
	const context = renderContext({ args: { command: "build" } });
	const partial = renderLines(
		bash.renderResult(
			result,
			{ expanded: false, isPartial: true } as never,
			theme,
			context,
		),
		200,
	).join("\n");
	assert.match(partial, /live-one[\s\S]*live-two/);
	assert.doesNotMatch(partial, /lines returned/);

	const complete = renderLines(
		bash.renderResult(result, collapsed, theme, context),
		200,
	).join("\n");
	assert.match(complete, /↳ 2 lines returned/);
	assert.doesNotMatch(complete, /live-one|live-two/);
});

test("bash collapsed render is the compact one-line summary", () => {
	const { bash } = createToolDisplayRenderers();
	const outputLines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
	const rendered = renderLines(
		bash.renderResult(
			textResult(outputLines.join("\n")),
			collapsed,
			theme,
			renderContext({ args: { command: "printf demo" } }),
		),
		200,
	);
	assert.equal(rendered.length, 1);
	assert.ok(rendered[0]!.includes("↳ 30 lines returned"));
	assert.ok(rendered[0]!.includes("Ctrl+O to expand"));
	assert.ok(!rendered[0]!.includes("line-30"));
});

test("bash call and error rows use configured styles", () => {
	const { bash } = createToolDisplayRenderers();
	const call = renderLines(
		bash.renderCall(
			{ command: "echo hi", timeout: 30 } as never,
			theme,
			renderContext({ executionStarted: false, isPartial: false }),
		),
		200,
	).join("\n");
	assert.ok(call.includes("$ echo hi"));
	assert.ok(call.includes("(timeout 30s)"));

	const error = renderLines(
		bash.renderResult(
			textResult("boom\nbroken pipe"),
			collapsed,
			theme,
			renderContext({ isError: true, args: { command: "false" } }),
		),
		200,
	).join("\n");
	assert.ok(error.includes("↳ command failed"));
	assert.ok(error.includes("boom"));
});

test("bash expanded render shows the full preview", () => {
	const { bash } = createToolDisplayRenderers();
	const outputLines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
	const rendered = renderLines(
		bash.renderResult(
			textResult(outputLines.join("\n")),
			expanded,
			theme,
			renderContext({ args: { command: "printf demo" } }),
		),
		200,
	).join("\n");
	assert.ok(rendered.includes("line-1"));
	assert.ok(rendered.includes("line-30"));
});

test("read result and tool calls use configured summaries", () => {
	const { read, edit, write } = createToolDisplayRenderers();
	const readResult = renderLines(
		read.renderResult(
			textResult("a\nb\nc\nd\ne"),
			collapsed,
			theme,
			renderContext({ args: { path: "src/foo.ts" } }),
		),
		200,
	);
	assert.equal(readResult.length, 1);
	assert.ok(readResult[0]!.includes("↳ loaded 5 lines"));

	const ctx = renderContext({ executionStarted: false, isPartial: false, argsComplete: true });
	const readCall = renderLines(
		read.renderCall({ path: "src/foo.ts", offset: 10, limit: 5 } as never, theme, ctx),
		200,
	).join("");
	assert.ok(readCall.includes("read src/foo.ts:10-14"));
	const editCall = renderLines(
		edit.renderCall({ path: "src/foo.ts", oldText: "a", newText: "x\ny" } as never, theme, ctx),
		200,
	).join("");
	assert.ok(editCall.includes("edit src/foo.ts (2 lines)"));
	const writeCall = renderLines(
		write.renderCall({ path: "src/foo.ts", content: "a\nb\n" } as never, theme, ctx),
		200,
	).join("");
	assert.ok(writeCall.includes("write src/foo.ts (2 lines"));
});

test("edit partial result shows the progress line", () => {
	const { edit } = createToolDisplayRenderers();
	const rendered = renderLines(
		edit.renderResult(
			textResult(""),
			{ expanded: false, isPartial: true } as never,
			theme,
			renderContext({ args: { path: "src/foo.ts", oldText: "a", newText: "x\ny" } }),
		),
		200,
	).join("");
	assert.ok(rendered.includes("editing..."));
	assert.ok(rendered.includes("(2 lines)"));
});

function buildAdditionDiff(lineCount: number): string {
	const added = Array.from({ length: lineCount }, (_, index) => `+added-${index + 1}`);
	return [`@@ -0,0 +1,${lineCount} @@`, ...added].join("\n");
}

test("edit diff caps collapsed output and switches split by width", () => {
	const { edit } = createToolDisplayRenderers();
	const capped = renderLines(
		edit.renderResult(
			textResult("ok", { diff: buildAdditionDiff(40), patch: "" }),
			collapsed,
			theme,
			renderContext({ args: { path: "src/foo.ts" } }),
		),
		100,
	);
	const cappedText = capped.join("\n");
	assert.ok(capped.length <= 30);
	assert.ok(cappedText.includes("added-1"));
	assert.ok(!cappedText.includes("added-40"));
	assert.match(cappedText, /more/);

	const diff = ["@@ -1,2 +1,2 @@", " shared", "-old_value", "+new_value"].join("\n");
	const details = textResult("ok", { diff, patch: "" });
	const context = renderContext({ args: { path: "src/foo.ts" } });
	const wide = renderLines(edit.renderResult(details, collapsed, theme, context), 200);
	assert.ok(wide.some((line) => line.includes("old_value") && line.includes("new_value")));
	const narrow = renderLines(edit.renderResult(details, collapsed, theme, context), 80);
	assert.equal(
		narrow.some((line) => line.includes("old_value") && line.includes("new_value")),
		false,
	);
});

test("write pre-capture renders overwrite and create diffs without wrapping execute", () => {
	// Drive the real production path: extension registration → tool_call event
	// → pre-execution capture → adapter-selected renderer via the real
	// ToolExecutionComponent.
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let registerToolCalls = 0;
	const pi = {
		registerTool: () => {
			registerToolCalls += 1;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	} as unknown as ExtensionAPI;
	toolDisplayExtension(pi);
	assert.equal(registerToolCalls, 0);

	const emit = (event: string, payload: unknown, ctx: unknown) => {
		for (const handler of handlers.get(event) ?? []) {
			void handler(payload, ctx);
		}
	};

	const renderWriteRow = (toolCallId: string, args: Record<string, unknown>): string => {
		initTheme("dark");
		// Minimal write definition: the adapter selects the package renderer and
		// never calls execute in this test.
		const definition = {
			name: "write",
			label: "write",
			description: "",
			parameters: {},
			execute: async () => ({ content: [] }),
		} as never;
		const component = new ToolExecutionComponent(
			"write",
			toolCallId,
			args,
			{ showImages: false, imageWidthCells: 20 },
			definition,
			{ requestRender: () => {} } as never,
			workDir,
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult(
			{ content: [{ type: "text", text: "ok" }], details: {}, isError: false } as never,
			false,
		);
		return stripAnsi(component.render(100).join("\n"));
	};

	const overwritePath = path.join(workDir, "overwrite.txt");
	fs.writeFileSync(overwritePath, "previous-content-line\n");
	emit(
			"tool_call",
			{ toolName: "write", toolCallId: "write-1", input: { path: "overwrite.txt" } },
			{ cwd: workDir },
	);
	const overwriteText = renderWriteRow("write-1", {
		path: "overwrite.txt",
		content: "replacement-content-line\n",
	});
	assert.ok(overwriteText.includes("previous-content-line"));
	assert.ok(overwriteText.includes("replacement-content-line"));

	// Non-write tools are not captured: a bash tool_call against the same file
	// must not seed write pre-execution content.
	emit(
			"tool_call",
			{ toolName: "bash", toolCallId: "bash-1", input: { path: "overwrite.txt" } },
			{ cwd: workDir },
	);
	assert.ok(
		!renderWriteRow("bash-1", { path: "overwrite.txt", content: "x\n" }).includes(
			"previous-content",
		),
	);

	// New-file write renders as pure additions.
	emit(
			"tool_call",
			{ toolName: "write", toolCallId: "write-2", input: { path: "new.txt" } },
			{ cwd: workDir },
	);
	const createText = renderWriteRow("write-2", {
		path: "new.txt",
		content: "fresh-1\nfresh-2\n",
	});
	assert.ok(createText.includes("fresh-1"));
	assert.ok(createText.includes("fresh-2"));
	assert.ok(!createText.includes("previous-content"));

	// Teardown: reload shutdown restores the patched prototype.
	emit("session_shutdown", { reason: "reload" }, {});
});
