import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	installToolExecutionAdapter,
	type CallRenderer,
	type ResultRenderer,
} from "./tool-execution-adapter.js";

const nativeCall = (() => new Text("native call", 0, 0)) as CallRenderer;
const customCall = (() => new Text("custom call", 0, 0)) as CallRenderer;
const nativeResult = (() => new Text("native result", 0, 0)) as ResultRenderer;
const customResult = (() => new Text("custom result", 0, 0)) as ResultRenderer;

interface FakeRow {
	toolName: string;
	invalidated: number;
	invalidate(): void;
	getCallRenderer(): CallRenderer | undefined;
	getResultRenderer(): ResultRenderer | undefined;
	getRenderShell(): NonNullable<ToolDefinition["renderShell"]>;
}

function createPrototype() {
	return {
		getCallRenderer(): CallRenderer | undefined {
			return nativeCall;
		},
		getResultRenderer(): ResultRenderer | undefined {
			return nativeResult;
		},
		getRenderShell(this: { toolName?: string }): "default" | "self" {
			return this.toolName === "edit" ? "self" : "default";
		},
	};
}

function createRow(prototype: object, toolName: string): FakeRow {
	const row = Object.create(prototype) as FakeRow;
	row.toolName = toolName;
	row.invalidated = 0;
	row.invalidate = () => {
		row.invalidated += 1;
	};
	return row;
}

test("adapter selects display renderers without mutating tool definitions", () => {
	const prototype = createPrototype();
	const installation = installToolExecutionAdapter(prototype, {
		call: (name, native) => (name === "bash" ? customCall : native),
		result: (name, native) => (name === "bash" ? customResult : native),
		shell: (name, native) => (name === "edit" ? "default" : native),
	});
	try {
		const bash = createRow(prototype, "bash");
		assert.equal(bash.getCallRenderer(), customCall);
		assert.equal(bash.getResultRenderer(), customResult);
		assert.equal(bash.getRenderShell(), "default");

		const edit = createRow(prototype, "edit");
		assert.equal(edit.getCallRenderer(), nativeCall);
		assert.equal(edit.getRenderShell(), "default");

		const other = createRow(prototype, "custom-tool");
		assert.equal(other.getCallRenderer(), nativeCall);
		assert.equal(other.getResultRenderer(), nativeResult);
		assert.equal(other.getRenderShell(), "default");
	} finally {
		installation.dispose();
	}
});

test("adapter dispose restores the exact native selectors", () => {
	const prototype = createPrototype();
	const originalCall = prototype.getCallRenderer;
	const originalResult = prototype.getResultRenderer;
	const originalShell = prototype.getRenderShell;
	const installation = installToolExecutionAdapter(prototype, {
		call: () => customCall,
		result: () => customResult,
		shell: () => "default",
	});
	assert.notEqual(prototype.getCallRenderer, originalCall);
	assert.notEqual(prototype.getResultRenderer, originalResult);
	assert.notEqual(prototype.getRenderShell, originalShell);

	installation.dispose();

	assert.equal(prototype.getCallRenderer, originalCall);
	assert.equal(prototype.getResultRenderer, originalResult);
	assert.equal(prototype.getRenderShell, originalShell);
});

test("re-install terminates when tracked rows re-enter patched getters from invalidate()", () => {
	const prototype = createPrototype();
	const resolver = {
		call: (_name: string, native: CallRenderer | undefined) => native,
		result: (_name: string, native: ResultRenderer | undefined) => native,
		shell: (_name: string, native: "default" | "self") => native,
	};
	const first = installToolExecutionAdapter(prototype, resolver);
	const rows: FakeRow[] = [];
	for (let i = 0; i < 3; i += 1) {
		const row = createRow(prototype, "bash");
		// Mirror ToolExecutionComponent.invalidate(): it synchronously runs
		// updateDisplay(), which re-invokes the patched renderer getters and
		// therefore re-enters trackRow while invalidateRows is iterating.
		row.invalidate = () => {
			row.invalidated += 1;
			row.getCallRenderer();
		};
		row.getCallRenderer(); // render pass tracks the row
		rows.push(row);
	}
	// Re-own path must invalidate every live row exactly once and return.
	const second = installToolExecutionAdapter(prototype, resolver);
	try {
		for (const row of rows) {
			assert.equal(row.invalidated, 1);
		}
	} finally {
		first.dispose();
		second.dispose();
	}
});

test("new installation replaces resolver ownership and stale dispose cannot remove it", () => {
	const prototype = createPrototype();
	const first = installToolExecutionAdapter(prototype, {
		call: () => customCall,
		result: (_name, native) => native,
		shell: (_name, native) => native,
	});
	const secondCall = (() => new Text("second", 0, 0)) as CallRenderer;
	const second = installToolExecutionAdapter(prototype, {
		call: () => secondCall,
		result: (_name, native) => native,
		shell: (_name, native) => native,
	});

	first.dispose();
	assert.equal(createRow(prototype, "bash").getCallRenderer(), secondCall);
	second.dispose();
	assert.equal(prototype.getCallRenderer(), nativeCall);
});
