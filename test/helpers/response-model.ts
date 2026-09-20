import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, FetchFunction, Model, StreamOptions } from "@earendil-works/pi-ai";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as azure } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { stream as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";

export type ResponseModelApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses";

export const REQUESTED_MODEL = "requested-model";
export const REPORTED_MODEL = "reported-model";

export function responseModelFixture<T extends Api>(api: T): Model<T> {
  return {
    id: REQUESTED_MODEL,
    name: "Response model fixture",
    api,
    provider: "fixture",
    baseUrl: "http://localhost:1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 128,
  };
}

export function responseEvents(reported: unknown = REPORTED_MODEL) {
  return [
    { type: "response.created", response: { id: "resp-test", model: reported } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg-test", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
    {
      type: "response.completed",
      response: {
        id: "resp-test",
        model: reported,
        status: "completed",
        output: [],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ];
}

export function completionEvents(reported: unknown = REPORTED_MODEL) {
  return [
    {
      id: "chat-test",
      model: reported,
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    },
    {
      id: "chat-test",
      model: reported,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ];
}

export function anthropicEvents(reported: unknown = REPORTED_MODEL) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg-test",
        model: reported,
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
}

/** Exercise real adapters with only the HTTP boundary replaced by an SSE fixture. */
export function fixtureStream(
  api: ResponseModelApi,
  events: readonly object[],
  overrides: Partial<StreamOptions> = {},
) {
  const sse = events
    .map((event) => {
      const type = "type" in event ? String(event.type) : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  const fixtureFetch: FetchFunction = Object.assign(
    async () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    { preconnect: fetch.preconnect },
  );
  const options: StreamOptions = {
    apiKey: "fixture-key",
    fetch: fixtureFetch,
    maxRetries: 0,
    ...overrides,
  };
  const context = normalizeContext({
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  });
  switch (api) {
    case "anthropic-messages":
      return anthropic(responseModelFixture(api), context, options);
    case "openai-completions":
      return completions(responseModelFixture(api), context, options);
    case "openai-responses":
      return responses(responseModelFixture(api), context, options);
    case "azure-openai-responses":
      return azure(responseModelFixture(api), context, {
        ...options,
        azureBaseUrl: "http://localhost:1/openai/v1",
        azureApiVersion: "2025-04-01-preview",
      });
    case "openai-codex-responses": {
      // The adapter only reads the account claim; no real credential or network is used.
      const payload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
      ).toString("base64url");
      return codex(responseModelFixture(api), context, {
        ...options,
        apiKey: `fixture.${payload}.fixture`,
        transport: "sse",
      });
    }
  }
}
