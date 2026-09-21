import type { StreamOptions } from "@earendil-works/pi-ai";
import { notifyProviderError } from "@earendil-works/pi-ai/utils/provider-error";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

interface ErrorFacts {
  name?: string;
  code?: string;
  status?: number;
}

const MAX_ERROR_NODES = 5;

/**
 * Install once when creating a shared runtime. Complete calls delegate to the
 * wrapped streaming methods. Callbacks belong to individual requests, including
 * when multiple tabs share the runtime.
 *
 * Raw exceptions are borrowed only during the callback. The console receives
 * bounded name/code/status facts, never message, stack, headers or body. Caller
 * cancellation still reaches its observer but does not emit a warning.
 */
export function configureProviderErrorDiagnostics(modelRuntime: ModelRuntime): void {
  const stream = modelRuntime.stream.bind(modelRuntime) as ModelRuntime["stream"];
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);

  // Preserve Pi's conditional API option type while adding only the observer.
  modelRuntime.stream = (model, context, options) =>
    stream(model, context, diagnosticOptions(options) as typeof options);
  modelRuntime.streamSimple = (model, context, options) =>
    streamSimple(model, context, diagnosticOptions(options));
}

function diagnosticOptions<T extends StreamOptions>(options?: T) {
  return {
    ...options,
    onProviderError: ((error, model) => {
      // Isolate the caller separately so its failure cannot suppress diagnostics.
      notifyProviderError(options?.onProviderError, error, model);
      if (options?.signal?.aborted) return;
      const errors = collectErrorFacts(error);
      if (errors.length === 0) return;
      console.warn(
        "[provider-error] %s",
        JSON.stringify({ provider: model.provider, model: model.id, api: model.api, errors }),
      );
    }) satisfies NonNullable<StreamOptions["onProviderError"]>,
  };
}

function diagnosticIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value)
    ? value
    : undefined;
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectErrorFacts(error: unknown): ErrorFacts[] {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const facts: ErrorFacts[] = [];

  // Cause chains can cycle; AggregateError can also fan out without a bound.
  for (let index = 0; index < pending.length && index < MAX_ERROR_NODES; index++) {
    const current = errorRecord(pending[index]);
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const name = diagnosticIdentifier(current.name);
    const code = diagnosticIdentifier(current.code);
    const status = current.status ?? errorRecord(current.$metadata)?.httpStatusCode;
    const validStatus =
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
    if (name || code || validStatus) {
      facts.push({
        ...(name ? { name } : {}),
        ...(code ? { code } : {}),
        ...(validStatus ? { status } : {}),
      });
    }
    if (current.cause !== undefined && pending.length < MAX_ERROR_NODES) {
      pending.push(current.cause);
    }
    if (Array.isArray(current.errors)) {
      pending.push(...current.errors.slice(0, MAX_ERROR_NODES - pending.length));
    }
  }
  return facts;
}
