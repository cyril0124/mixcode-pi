import {
  type Context,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { MixCodeModel } from "../core/types.js";

export const MIXCODE_FAUX_MODEL: MixCodeModel = {
  id: "faux-1",
  name: "Faux MixCode Model",
  api: "mixcode-faux",
  provider: "faux",
  baseUrl: "local://mixcode-faux",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

// pi-ai faux core. Huge fixed tokenSize keeps one delta per content block and
// avoids Math.random() chunking; no tokensPerSecond keeps microtask pacing.
const fauxCore = createFauxCore({
  api: MIXCODE_FAUX_MODEL.api,
  provider: MIXCODE_FAUX_MODEL.provider,
  tokenSize: { min: 1 << 20, max: 1 << 20 },
});

const echoStep = (context: Context) =>
  fauxAssistantMessage([
    fauxThinking("Inspecting the latest user request before answering."),
    fauxText(`Echo: ${lastUserText(context)}`),
  ]);

export function mixcodeFauxStream(
  model: MixCodeModel,
  context: Context,
  options?: SimpleStreamOptions,
) {
  // The core consumes one queued response per stream call and errors on an
  // empty queue; queueing exactly one step per call keeps the echo infinite.
  fauxCore.setResponses([echoStep]);
  // Contract (runtime-ui-24): echo works even when context carries junk-role
  // entries. The core's usage estimator dispatches on message.role and throws
  // on anything outside user/assistant/toolResult, so strip unknown roles.
  const safeContext: Context = {
    ...context,
    messages: context.messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
    ),
  };
  // cacheRetention "none" disables the core's prompt-cache simulation so faux
  // usage never reports cacheRead/cacheWrite tokens.
  return fauxCore.stream(model, safeContext, { ...options, cacheRetention: "none" });
}

function lastUserText(context: Context): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    const parts: string[] = [];
    for (const block of message.content) {
      parts.push(block.type === "text" ? block.text : "[image]");
    }
    return parts.join("\n");
  }
  return "";
}
