import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { commitState, disposeSession } from "./state/store.js";
import { TodoOverlay } from "./todo-overlay.js";
import type { Task } from "./tool/types.js";

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
