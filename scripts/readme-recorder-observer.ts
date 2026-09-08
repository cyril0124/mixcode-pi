import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Report settled responses for the recorder's single-agent model scenarios. */
export default function (pi: ExtensionAPI): void {
  const directory = process.env.MIXCODE_GIF_RESPONSE_DIR;
  if (!directory) throw new Error("Error: Missing recorder response directory");

  let requestId: string | undefined;
  let sessionId: string | undefined;
  let response: AssistantMessage | undefined;

  pi.on("before_agent_start", async (_event, ctx) => {
    // Bind the nonce before this submission can produce any assistant message.
    const nextRequestId = await fs.readFile(path.join(directory, "request-id"), "utf8");
    if (!/^[a-f0-9]{32}$/.test(nextRequestId)) {
      throw new Error("Error: Invalid recorder request ID");
    }
    requestId = nextRequestId;
    sessionId = ctx.sessionManager.getSessionId();
    response = undefined;
  });

  pi.on("message_end", (event) => {
    if (requestId && event.message.role === "assistant") response = event.message;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!requestId || sessionId !== ctx.sessionManager.getSessionId() || !ctx.isIdle()) {
      return;
    }
    // agent_end can precede retries. Publish only after the entire request settles.
    const completion = {
      requestId,
      stopReason: response?.stopReason ?? "error",
      text:
        response?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? "",
    };
    const pending = path.join(directory, "response.pending");
    await fs.writeFile(pending, JSON.stringify(completion));
    await fs.rename(pending, path.join(directory, "response.json"));
    requestId = undefined;
    response = undefined;
  });
}
