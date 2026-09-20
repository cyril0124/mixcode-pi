import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { test } from "node:test";
import {
  anthropicEvents,
  completionEvents,
  fixtureStream,
  REPORTED_MODEL,
  REQUESTED_MODEL,
  responseEvents,
  responseModelFixture,
  type ResponseModelApi,
} from "./helpers/response-model.js";

const apis: ResponseModelApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
];

for (const api of apis) {
  const events =
    api === "anthropic-messages"
      ? anthropicEvents
      : api === "openai-completions"
        ? completionEvents
        : responseEvents;
  test(`${api} retains the reported model without changing requested model or usage`, async () => {
    const result = await fixtureStream(api, events()).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.responseModel, REPORTED_MODEL);
    assert.equal(result.model, REQUESTED_MODEL);
    assert.equal(result.usage.input, 10);
    assert.equal(result.usage.output, 2);
    assert.equal(Number(result.usage.cost.total.toFixed(12)), 0.000014);
    assert.deepEqual(
      result.content.filter((block) => block.type === "text").map((block) => block.text),
      ["Hello"],
    );
  });

  test(`${api} does not record a model difference for identical or missing names`, async () => {
    for (const name of [REQUESTED_MODEL, null]) {
      const wireEvents = events(name);
      // Missing metadata must not be manufactured from the request.
      const withoutNull: object[] = JSON.parse(
        JSON.stringify(wireEvents, (_key, value) => (value === null ? undefined : value)),
      );
      const result = await fixtureStream(api, withoutNull).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(result.responseModel, undefined);
    }
  });
}

for (const api of apis.filter((api) => api.endsWith("responses"))) {
  test(`${api} captures a model reported only by the terminal event`, async () => {
    const events = responseEvents();
    events.shift();
    const result = await fixtureStream(api, events).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.responseModel, REPORTED_MODEL);
  });
}

for (const [reported, expected] of [
  ["final-model", "final-model"],
  [REQUESTED_MODEL, undefined],
  [null, REPORTED_MODEL],
  ["", REPORTED_MODEL],
  ["  ", REPORTED_MODEL],
  [123, REPORTED_MODEL],
] as const) {
  test(`Responses terminal model ${JSON.stringify(reported)} updates only valid metadata`, async () => {
    const events: object[] = responseEvents();
    events[events.length - 1] = {
      type: "response.completed",
      response: { status: "completed", model: reported, output: [] },
    };
    const result = await fixtureStream("openai-responses", events).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.responseModel, expected);
  });
}

for (const terminal of ["response.incomplete", "response.failed"] as const) {
  test(`Responses retains reported model on ${terminal}`, async () => {
    const result = await fixtureStream("openai-responses", [
      {
        type: terminal,
        response: {
          status: terminal === "response.failed" ? "failed" : "incomplete",
          model: REPORTED_MODEL,
          output: [],
          incomplete_details: { reason: "max_output_tokens" },
          error: { code: "fixture", message: "fixture failure" },
        },
      },
    ]).result();
    assert.equal(result.responseModel, REPORTED_MODEL);
    assert.equal(result.stopReason, terminal === "response.failed" ? "error" : "length");
    if (terminal === "response.failed") assert.match(result.errorMessage ?? "", /fixture failure/);
  });
}

test("Codex WebSocket responses retain the reported model without HTTP fallback", async () => {
  let requestedModel: unknown;
  let fallbackRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      fallbackRequests++;
      return new Response("Unexpected HTTP fallback", { status: 500 });
    },
    websocket: {
      message(socket, payload) {
        const request = JSON.parse(String(payload));
        requestedModel = request.model;
        for (const event of responseEvents()) socket.send(JSON.stringify(event));
      },
    },
  });
  try {
    const claims = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
      }),
    ).toString("base64url");
    const result = await streamCodex(
      { ...responseModelFixture("openai-codex-responses"), baseUrl: server.url.href },
      normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
      {
        apiKey: `fixture.${claims}.fixture`,
        transport: "websocket",
        maxRetries: 0,
        signal: AbortSignal.timeout(5000),
        env: {},
      },
    ).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.responseModel, REPORTED_MODEL);
    assert.equal(requestedModel, REQUESTED_MODEL);
    assert.equal(fallbackRequests, 0);
  } finally {
    await server.stop(true);
  }
});

test("Responses preserves model metadata received before an interrupted stream", async () => {
  const result = await fixtureStream("openai-responses", responseEvents().slice(0, 3)).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /terminal response event/);
  assert.equal(result.responseModel, REPORTED_MODEL);
});

test("Responses preserves model metadata when the caller aborts after a text delta", async () => {
  const controller = new AbortController();
  const stream = fixtureStream("openai-responses", responseEvents(), { signal: controller.signal });
  for await (const event of stream) {
    if (event.type === "text_delta") controller.abort();
  }
  const result = await stream.result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.responseModel, REPORTED_MODEL);
});
