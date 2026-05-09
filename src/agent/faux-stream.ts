import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const MIXCODE_FAUX_MODEL: Model<string> = {
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

export function mixcodeFauxStream(
  model: Model<any>,
  context: Context,
  _options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const text = `Echo: ${lastUserText(context)}`;
    const thinking = "Inspecting the latest user request before answering.";
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        ...EMPTY_USAGE,
        input: Math.ceil(JSON.stringify(context.messages).length / 4),
        output: Math.ceil(text.length / 4),
        totalTokens:
          Math.ceil(JSON.stringify(context.messages).length / 4) + Math.ceil(text.length / 4),
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({
      type: "thinking_start",
      contentIndex: 0,
      partial: { ...message, content: [{ type: "thinking", thinking: "" }] },
    });
    stream.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: thinking,
      partial: { ...message, content: [{ type: "thinking", thinking }] },
    });
    stream.push({
      type: "thinking_end",
      contentIndex: 0,
      content: thinking,
      partial: { ...message, content: [{ type: "thinking", thinking }] },
    });
    stream.push({
      type: "text_start",
      contentIndex: 1,
      partial: {
        ...message,
        content: [
          { type: "thinking", thinking },
          { type: "text", text: "" },
        ],
      },
    });
    stream.push({ type: "text_delta", contentIndex: 1, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 1, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
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
