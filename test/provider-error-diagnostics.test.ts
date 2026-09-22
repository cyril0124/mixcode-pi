import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getConsoleHistory, installConsoleTuiBridge } from "../src/cli/console-tui-bridge.js";
import { createPiModelRegistryBundle } from "../src/core/pi-models.js";

const consoleMethods = {
  log: console.log,
  info: console.info,
  debug: console.debug,
  warn: console.warn,
  error: console.error,
};
installConsoleTuiBridge();
after(() => Object.assign(console, consoleMethods));

async function withRuntime(
  run: (bundle: Awaited<ReturnType<typeof createPiModelRegistryBundle>>) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-provider-diagnostics-"));
  try {
    const modelsPath = path.join(dir, "models.json");
    await Bun.write(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "http://localhost:1/v1",
            apiKey: "fixture-key",
            models: [{ id: "fixture-model", name: "Fixture" }],
          },
        },
      }),
    );
    await run(await createPiModelRegistryBundle(modelsPath, path.join(dir, "auth.json")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function diagnosticsSince(start: number) {
  return getConsoleHistory()
    .slice(start)
    .filter((line) => line.includes("[provider-error] "))
    .map(
      (line) =>
        JSON.parse(line.split("[provider-error] ")[1]!) as {
          errors: Array<{ name?: string; code?: string; status?: number }>;
        },
    );
}

for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
  test(`shared runtime ${method} records cause facts without serializing raw errors`, async () => {
    await withRuntime(async ({ modelRuntime }) => {
      const start = getConsoleHistory().length;
      const cause = Object.assign(new Error("secret nested message"), { code: "ENOTFOUND" });
      const failure = Object.assign(new Error("Connection error.", { cause }), {
        name: "APIConnectionError",
        headers: { authorization: "Bearer secret-header" },
        body: "secret-body",
        stack: "secret-stack",
      });
      const observed: unknown[] = [];
      const model = modelRuntime.getModel("fixture", "fixture-model")!;
      const options: SimpleStreamOptions = {
        onPayload: () => {
          throw failure;
        },
        onProviderError: (error) => {
          observed.push(error);
          throw new Error("observer failed");
        },
        maxRetries: 0,
      };
      const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }] };
      const pending = modelRuntime[method](model, context, options);
      const result = "result" in pending ? await pending.result() : await pending;
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage ?? "", /Connection error/);
      assert.deepEqual(observed, [failure]);
      assert.deepEqual(diagnosticsSince(start), [
        {
          provider: "fixture",
          model: "fixture-model",
          api: "openai-completions",
          errors: [{ name: "APIConnectionError" }, { name: "Error", code: "ENOTFOUND" }],
        },
      ]);
      assert.equal(getConsoleHistory().slice(start).join("\n").includes("secret"), false);
    });
  });
}

test("diagnostics retain HTTP status and bound cyclic cause chains", async () => {
  await withRuntime(async ({ modelRuntime }) => {
    const start = getConsoleHistory().length;
    const failure = Object.assign(new Error("private response"), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    failure.cause = failure;
    await modelRuntime.completeSimple(
      modelRuntime.getModel("fixture", "fixture-model")!,
      { messages: [] },
      {
        onPayload: () => {
          throw failure;
        },
      },
    );
    assert.deepEqual(diagnosticsSince(start)[0]?.errors, [
      { name: "Error", code: "rate_limit_exceeded", status: 429 },
    ]);
  });
});

test("caller cancellation keeps the aborted result and produces no diagnostic warning", async () => {
  await withRuntime(async ({ modelRuntime }) => {
    const start = getConsoleHistory().length;
    const controller = new AbortController();
    const observed: unknown[] = [];
    const failure = new Error("cancelled");
    const result = await modelRuntime.completeSimple(
      modelRuntime.getModel("fixture", "fixture-model")!,
      { messages: [] },
      {
        signal: controller.signal,
        onPayload: () => {
          controller.abort();
          throw failure;
        },
        onProviderError: (error) => {
          observed.push(error);
        },
      },
    );
    assert.equal(result.stopReason, "aborted");
    assert.deepEqual(observed, [failure]);
    assert.deepEqual(diagnosticsSince(start), []);
  });
});

test("concurrent requests keep separate observers and diagnostics", async () => {
  await withRuntime(async ({ modelRuntime }) => {
    const start = getConsoleHistory().length;
    const model = modelRuntime.getModel("fixture", "fixture-model")!;
    const failures = ["ENOTFOUND", "CERT_HAS_EXPIRED"].map((code) =>
      Object.assign(new Error("Connection error."), { code }),
    );
    const observed: unknown[][] = [[], []];
    const results = await Promise.all(
      failures.map((failure, index) =>
        modelRuntime.completeSimple(
          model,
          { messages: [] },
          {
            onPayload: async () => {
              await new Promise<void>((resolve) => setImmediate(resolve));
              throw failure;
            },
            onProviderError: (error) => {
              observed[index]!.push(error);
            },
          },
        ),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.stopReason),
      ["error", "error"],
    );
    assert.deepEqual(
      observed,
      failures.map((failure) => [failure]),
    );
    assert.deepEqual(
      diagnosticsSince(start)
        .map((entry) => entry.errors[0]?.code)
        .sort(),
      ["CERT_HAS_EXPIRED", "ENOTFOUND"],
    );
  });
});

test("diagnostics bound aggregate errors and omit invalid identifiers and statuses", async () => {
  await withRuntime(async ({ modelRuntime }) => {
    const start = getConsoleHistory().length;
    const errors = Array.from({ length: 20 }, () =>
      Object.assign(new Error("private child"), { code: "ECONNREFUSED" }),
    );
    const failure = Object.assign(new AggregateError(errors, "private aggregate"), {
      name: "not a valid name\u001b[31m",
      code: "Bearer private-token",
      status: 999,
    });
    await modelRuntime.completeSimple(
      modelRuntime.getModel("fixture", "fixture-model")!,
      { messages: [] },
      {
        onPayload: () => {
          throw failure;
        },
      },
    );
    assert.deepEqual(
      diagnosticsSince(start)[0]?.errors,
      Array.from({ length: 4 }, () => ({ name: "Error", code: "ECONNREFUSED" })),
    );
    const logs = getConsoleHistory().slice(start).join("\n");
    assert.equal(logs.includes("private"), false);
    assert.equal(logs.includes("\\u001b"), false);
  });
});
