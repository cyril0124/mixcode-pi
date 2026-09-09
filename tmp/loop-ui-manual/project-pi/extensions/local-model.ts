import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Supply local model traffic; all scheduling, pending state and UI come from mpi-loop. */
export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({
    provider: "loop-ui-demo",
    api: "openai-completions",
    models: [{ id: "alpha", name: "Loop UI Offline", contextWindow: 128_000, maxTokens: 16_384 }],
  });
  pi.registerProvider("loop-ui-demo", {
    api: "openai-completions",
    apiKey: "local-only",
    baseUrl: "http://127.0.0.1:1",
    models: faux.models,
    streamSimple(model, context, options) {
      faux.appendResponses([async (_context, responseOptions, state) => {
        // The first real response spans two 10-second ticks, exposing defer's waiting state.
        await delay(state.callCount === 1 ? 25_000 : 250, undefined, {
          signal: responseOptions?.signal,
        });
        return fauxAssistantMessage(`Local reply ${state.callCount}. Offline model; no tools executed.`);
      }]);
      return faux.provider.streamSimple(model, context, options);
    },
  });
}
