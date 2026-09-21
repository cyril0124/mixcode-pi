# Provider error diagnostics

[中文文档](provider-errors.zh.md)

## Inspect a failed request

Open `/console-history` after a model request fails. `[provider-error]` records
identify the provider, requested model, API, and error fields. For example:

```json
{"provider":"custom","model":"example","api":"openai-completions","errors":[{"name":"APIConnectionError"},{"name":"Error","code":"ENOTFOUND"}]}
```

Records stay in the process-local console history. Raw exceptions are not added
to session messages or written to a separate log file. Caller cancellation does
not produce a diagnostic warning. Conversation errors and retries follow the
usual provider behavior.

## Raw exception callback

The patched `pi-ai` text adapters accept this optional callback in
`StreamOptions` and `SimpleStreamOptions`:

```ts
onProviderError?: (error: unknown, model: Model<Api>) => void;
```

Adapters pass the caught exception before formatting the terminal error. Treat
`error` and `model` as read-only borrowed references. The callback runs
synchronously; returned promises are not awaited. Observer throws and promise
rejections are ignored so the stream can finish with its original error.

Each terminal catch notifies once, including caught aborts. Failed adapter
retries notify only when exhausted. Failures recovered by a retry or transport
fallback do not notify. A host retry starts a separate request and may notify
again. The exception retains any `cause` supplied by the SDK.

Coverage includes Anthropic Messages, OpenAI Chat Completions and Responses,
Azure Responses, Codex Responses, Google Generative AI and Vertex, Bedrock
Converse, Mistral Conversations, Pi Messages, and exceptions thrown during
ordinary faux streaming. Image generation, deferred operations, authentication
or lazy setup failures before adapter entry, and error results without a thrown
exception are outside this callback's scope. Custom providers must invoke it
when they catch exceptions.

## mpi integration

[`src/core/pi-models.ts`](../src/core/pi-models.ts) installs
[`configureProviderErrorDiagnostics`](../src/core/provider-error-diagnostics.ts)
on each shared `ModelRuntime` it creates. It wraps `stream` and `streamSimple`;
`complete` and `completeSimple` delegate to those methods. Agent turns and
compaction requests through that runtime receive diagnostics. Independently
created runtimes require their own installation.

Install once per runtime. Concurrent requests keep separate caller observers,
whose exceptions are isolated from mpi diagnostics. Provider registration and
cancellation semantics are preserved.

The logger examines up to five exception nodes through `cause` and
`AggregateError.errors`, with cycle protection. It records only:

- `name` and `code` matching `[a-zA-Z][a-zA-Z0-9_.-]{0,79}`.
- Integer HTTP `status` from 100 through 599, falling back to AWS
  `$metadata.httpStatusCode` when `status` is absent.

Nodes without accepted fields are omitted. Exception messages, stacks, headers,
bodies, and credential fields are excluded. Callers supplying their own
observers are responsible for redaction and storage of the raw objects.
