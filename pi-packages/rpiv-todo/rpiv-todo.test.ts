import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_COLLAPSE_KEY,
	isValidCollapseKeySpec,
	resolveCollapseKey,
} from "./config.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, disposeSession } from "./state/store.js";
import { TodoOverlay } from "./todo-overlay.js";
import { formatContent } from "./tool/response-envelope.js";
import type { Task } from "./tool/types.js";

test("resolveCollapseKey falls back for non-string JSON values", async () => {
	const home = await mkdtemp(join(tmpdir(), "rpiv-todo-config-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const config = join(home, ".config", "rpiv-todo", "config.json");
		await mkdir(dirname(config), { recursive: true });
		await writeFile(config, JSON.stringify({ collapseKey: 42 }), "utf8");
		assert.equal(resolveCollapseKey(), DEFAULT_COLLAPSE_KEY);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("collapse key validation rejects specs Pi cannot match", () => {
	assert.equal(isValidCollapseKeySpec("ctrl+shift+t"), true);
	assert.equal(isValidCollapseKeySpec('"'), false);
	assert.equal(isValidCollapseKeySpec("ctrl+f1"), false);
});

test("no-op update returns explicit No change feedback", () => {
	const task: Task = { id: 1, subject: "ship", status: "in_progress" };
	const result = applyTaskMutation({ tasks: [task], nextId: 2 }, "update", {
		id: 1,
		status: "in_progress",
	});
	assert.equal(result.op.kind, "update");
	if (result.op.kind !== "update") return;
	assert.equal(result.op.changed, false);
	assert.equal(
		formatContent(result.op, result.state),
		"No change: #1 already matches the requested values (status: in_progress)",
	);
});

test("todo overlay keeps the upstream 12-content-row budget", async () => {
	const home = await mkdtemp(join(tmpdir(), "rpiv-todo-overlay-"));
	const previousHome = process.env.HOME;
	const sessionId = "overlay-budget";
	process.env.HOME = home;
	const tasks: Task[] = Array.from({ length: 12 }, (_, index) => ({
		id: index + 1,
		subject: `task-${index + 1}`,
		status: "pending",
	}));
	commitState(sessionId, { tasks, nextId: 13 });
	let factory:
		| ((
				tui: { requestRender: (...args: unknown[]) => void },
				theme: unknown,
			) => { render: (width: number) => string[] })
		| undefined;
	const ui = {
		theme: identityTheme(),
		setWidget: (_key: string, value: unknown) => {
			if (typeof value === "function") factory = value as typeof factory;
		},
	} as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay(sessionId);
	try {
		overlay.setUICtx(ui);
		overlay.update();
		assert.ok(factory);
		const widget = factory({ requestRender: () => undefined }, identityTheme());
		const lines = widget.render(120);
		assert.equal(lines.length, 13);
		assert.match(lines.at(-2) ?? "", /\+2 more/);
		assert.equal(lines.at(-1), "");
	} finally {
		overlay.dispose();
		disposeSession(sessionId);
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

function identityTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
}
