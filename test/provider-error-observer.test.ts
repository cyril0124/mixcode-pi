import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import * as anthropic from "@earendil-works/pi-ai/api/anthropic-messages";
import * as azure from "@earendil-works/pi-ai/api/azure-openai-responses";
import * as bedrock from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import * as google from "@earendil-works/pi-ai/api/google-generative-ai";
import * as vertex from "@earendil-works/pi-ai/api/google-vertex";
import * as mistral from "@earendil-works/pi-ai/api/mistral-conversations";
import * as codex from "@earendil-works/pi-ai/api/openai-codex-responses";
import * as completions from "@earendil-works/pi-ai/api/openai-completions";
import * as responses from "@earendil-works/pi-ai/api/openai-responses";
import * as piMessages from "@earendil-works/pi-ai/api/pi-messages";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  completionEvents,
  fixtureStream,
  responseModelFixture,
  type ResponseModelApi,
} from "./helpers/response-model.js";

const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const claims = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64url");
const baseOptions: SimpleStreamOptions = {
  apiKey: `fixture.${claims}.fixture`,
  transport: "sse",
  maxRetries: 0,
  env: { AZURE_OPENAI_BASE_URL: "http://localhost:1/openai/v1", AWS_REGION: "us-east-1" },
};

function adapter<T extends Api>(
  api: T,
  implementation: {
    stream: StreamFunction<T>;
    streamSimple: StreamFunction<T, SimpleStreamOptions>;
  },
) {
  const model = responseModelFixture(api);
  return {
    api,
    model,
    run: (kind: "stream" | "streamSimple", options: SimpleStreamOptions) =>
      implementation[kind](model, context, { ...baseOptions, ...options }),
  };
}

const adapters = [
  adapter("anthropic-messages", anthropic),
  adapter("azure-openai-responses", azure),
  adapter("bedrock-converse-stream", bedrock),
  adapter("google-generative-ai", google),
  adapter("google-vertex", vertex),
  adapter("mistral-conversations", mistral),
  adapter("openai-codex-responses", codex),
  adapter("openai-completions", completions),
  adapter("openai-responses", responses),
  adapter("pi-messages", piMessages),
];

for (const provider of adapters) {
  for (const kind of ["stream", "streamSimple"] as const) {
    test(`${provider.api} ${kind} observes the original terminal exception before emitting its error`, async () => {
      const cause = Object.assign(new Error("fixture DNS failure"), { code: "ENOTFOUND" });
      const failure = new Error("fixture request failed", { cause });
      const observed: Array<{ error: unknown; model: Model<Api> }> = [];
      const stream = provider.run(kind, {
        onPayload: () => {
          throw failure;
        },
        onProviderError: (error, model) => {
          observed.push({ error, model });
        },
      });
      for await (const event of stream) {
        if (event.type === "error") assert.equal(observed.length, 1);
      }
      const result = await stream.result();
      assert.equal(result.stopReason, "error");
      assert.equal(observed.length, 1);
      assert.equal(observed[0]?.error, failure);
      assert.equal(observed[0]?.model, provider.model);
      assert.equal((observed[0]?.error as Error).cause, cause);
      assert.match(result.errorMessage ?? "", /fixture request failed/);
      assert.equal(JSON.stringify(result).includes("fixture DNS failure"), false);
    });
  }
}

const httpApis: ResponseModelApi[] = [
  "anthropic-messages",
  "azure-openai-responses",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
];

for (const api of httpApis) {
  test(`${api} retains transport failure cause through the SDK`, async () => {
    const failure = Object.assign(new Error("fixture connection refused"), {
      code: "ECONNREFUSED",
    });
    const observed: unknown[] = [];
    const result = await fixtureStream(api, [], {
      fetch: Object.assign(
        async () => {
          throw failure;
        },
        { preconnect: fetch.preconnect },
      ),
      onProviderError: (error) => {
        observed.push(error);
      },
    }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(observed.length, 1);
    assert.ok(
      observed[0] === failure || (observed[0] instanceof Error && observed[0].cause === failure),
    );
  });
}

for (const observerFailure of ["throw", "reject"] as const) {
  test(`observer ${observerFailure} cannot replace the provider failure or strand the stream`, async () => {
    const result = await fixtureStream("openai-completions", [], {
      onPayload: () => {
        throw new Error("original provider failure");
      },
      onProviderError: () => {
        if (observerFailure === "throw") throw new Error("observer failure");
        return Promise.reject(new Error("observer failure"));
      },
    }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /original provider failure/);
    assert.equal(result.errorMessage?.includes("observer failure"), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

test("successful completion never calls the error observer", async () => {
  const observed: unknown[] = [];
  const result = await fixtureStream("openai-completions", completionEvents(), {
    onProviderError: (error) => {
      observed.push(error);
    },
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(observed, []);
});

test("faux provider retains errors thrown by response functions", async () => {
  const failure = new Error("faux failed", { cause: new Error("nested cause") });
  const faux = fauxProvider();
  faux.setResponses([
    () => {
      throw failure;
    },
  ]);
  const observed: unknown[] = [];
  const result = await faux.provider
    .streamSimple(faux.models[0]!, context, {
      onProviderError: (error) => {
        observed.push(error);
      },
    })
    .result();
  assert.equal(result.stopReason, "error");
  assert.deepEqual(observed, [failure]);
});

for (const recover of [true, false]) {
  test(`adapter retries ${recover ? "recover without notification" : "notify once on final HTTP failure"}`, async () => {
    let requests = 0;
    const observed: unknown[] = [];
    const sse = completionEvents()
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const result = await completions
      .streamSimple(responseModelFixture("openai-completions"), context, {
        ...baseOptions,
        maxRetries: 1,
        fetch: Object.assign(
          async () => {
            requests++;
            if (recover && requests === 2) {
              return new Response(sse, { headers: { "content-type": "text/event-stream" } });
            }
            return new Response(
              JSON.stringify({ error: { message: "fixture unavailable", type: "server_error" } }),
              {
                status: 503,
                headers: { "content-type": "application/json", "retry-after": "0" },
              },
            );
          },
          { preconnect: fetch.preconnect },
        ),
        onProviderError: (error) => {
          observed.push(error);
        },
      })
      .result();
    assert.equal(requests, 2);
    assert.equal(result.stopReason, recover ? "stop" : "error");
    assert.equal(observed.length, recover ? 0 : 1);
    if (!recover) {
      assert.equal((observed[0] as { status: number }).status, 503);
      assert.match(result.errorMessage ?? "", /fixture unavailable/);
    }
  });
}

test("a failure while reading response bytes reaches the observer with its original cause", async () => {
  const failure = Object.assign(new Error("fixture stream broken"), { code: "ECONNRESET" });
  const observed: unknown[] = [];
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ === 0) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(completionEvents()[0])}\n\n`),
        );
      } else {
        controller.error(failure);
      }
    },
  });
  const result = await fixtureStream("openai-completions", [], {
    fetch: Object.assign(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      { preconnect: fetch.preconnect },
    ),
    onProviderError: (error) => {
      observed.push(error);
    },
  }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(observed.length, 1);
  assert.ok(
    observed[0] === failure || (observed[0] instanceof Error && observed[0].cause === failure),
  );
  assert.match(result.errorMessage ?? "", /fixture stream broken/);
});
