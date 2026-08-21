import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThinkingLabeling } from "./thinking-label.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function registerHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	} as unknown as ExtensionAPI;
	registerThinkingLabeling(pi);
	return {
		handlers,
		ctx: {
			ui: {
				theme: {
					fg: (color: string, text: string) =>
						color === "accent" ? `\u001b[36m${text}\u001b[0m` : `\u001b[2m${text}\u001b[0m`,
				},
				notify: () => {},
			},
		},
	};
}

async function emit(
	handlers: Map<string, Handler[]>,
	event: string,
	payload: unknown,
	ctx: unknown,
): Promise<unknown> {
	let result: unknown;
	for (const handler of handlers.get(event) ?? []) {
		result = await handler(payload, ctx);
	}
	return result;
}

test("message_update adds the themed Thinking label to thinking blocks", async () => {
	const { handlers, ctx } = registerHarness();
	const message = {
		role: "assistant",
		api: "anthropic-messages",
		content: [
			{ type: "thinking", thinking: "inspect the call graph" },
			{ type: "text", text: "answer" },
		],
	};

	await emit(handlers, "message_update", { message }, ctx);

	assert.equal(
		message.content[0]!.thinking,
		"\u001b[36mThinking:\u001b[0m \u001b[2minspect the call graph\u001b[0m",
	);
	assert.deepEqual(message.content[1], { type: "text", text: "answer" });
});

test("thinking labeling is idempotent across update and end events", async () => {
	const { handlers, ctx } = registerHarness();
	const message = {
		role: "assistant",
		api: "openai-responses",
		content: [{ type: "thinking", thinking: "reason once" }],
	};

	await emit(handlers, "message_update", { message }, ctx);
	await emit(handlers, "message_end", { message }, ctx);

	const thinking = message.content[0]!.thinking;
	assert.equal((thinking.match(/Thinking:/g) ?? []).length, 1);
	assert.ok(thinking.endsWith("reason once\u001b[0m"));
});

test("unrelated OpenAI transports are not labeled", async () => {
	const { handlers, ctx } = registerHarness();
	const message = {
		role: "assistant",
		api: "openai-custom-transport",
		content: [{ type: "thinking", thinking: "leave untouched" }],
	};

	await emit(handlers, "message_update", { message }, ctx);

	assert.equal(message.content[0]!.thinking, "leave untouched");
});

test("context event strips persisted labels and ANSI presentation artifacts", async () => {
	const { handlers, ctx } = registerHarness();
	const messages = [
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "\u001b[36mThinking:\u001b[0m \u001b[2mThinking: evaluate evidence\u001b[0m",
				},
				{ type: "text", text: "answer" },
			],
		},
		{ role: "user", content: "keep" },
	];

	const result = (await emit(handlers, "context", { messages }, ctx)) as {
		messages: typeof messages;
	};

	const assistantContent = messages[0]!.content as Array<{
		type: string;
		thinking?: string;
		text?: string;
	}>;
	assert.equal(assistantContent[0]!.thinking, "evaluate evidence");
	assert.deepEqual(assistantContent[1], { type: "text", text: "answer" });
	assert.deepEqual(messages[1], { role: "user", content: "keep" });
	// The returned messages array is the formal contract and must be the
	// sanitized one: no labels, no ANSI.
	assert.deepEqual(result.messages, messages);
	assert.equal(result.messages, messages);
});

test("context sanitization never strips ordinary leading text like measurements", async () => {
	const { handlers, ctx } = registerHarness();
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Thinking: 38m cable needed" },
				{ type: "thinking", thinking: "5m walk to station" },
			],
		},
	];

	await emit(handlers, "context", { messages }, ctx);

	const content = messages[0]!.content as Array<{ thinking?: string }>;
	assert.equal(content[0]!.thinking, "38m cable needed");
	assert.equal(content[1]!.thinking, "5m walk to station");
});

test("registerThinkingLabeling installs each handler only once per ExtensionAPI", () => {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	} as unknown as ExtensionAPI;

	registerThinkingLabeling(pi);
	registerThinkingLabeling(pi);

	assert.equal(handlers.get("message_update")?.length, 1);
	assert.equal(handlers.get("message_end")?.length, 1);
	assert.equal(handlers.get("context")?.length, 1);
	assert.equal(handlers.get("session_shutdown")?.length, 1);
});
