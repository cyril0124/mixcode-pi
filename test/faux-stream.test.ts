import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  normalizeContext,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";

const tool = {
  name: "inspect",
  description: "Inspect the current workspace.",
  parameters: Type.Object({ path: Type.String() }),
};

const systemMessages: SystemMessage[] = [
  { role: "system", content: "Keep all responses concise.", timestamp: 1 },
  { role: "system", content: "", toolsAdded: [tool], timestamp: 1 },
  {
    role: "system",
    content: "Use the updated workspace instructions.",
    toolsRemoved: [{ name: "inspect" }],
    timestamp: 3,
  },
];

for (const system of systemMessages) {
  test(`faux stream retains transcript state: ${system.content || "tool declaration"}`, async () => {
    const context = normalizeContext({
      messages: [{ role: "user", content: "ping", timestamp: 2 }, system],
    });
    const result = await mixcodeFauxStream(MIXCODE_FAUX_MODEL, context).result();
    const reference = createFauxCore({
      api: MIXCODE_FAUX_MODEL.api,
      provider: MIXCODE_FAUX_MODEL.provider,
    });
    reference.setResponses([fauxAssistantMessage("Echo: ping")]);
    const expected = await reference.stream(MIXCODE_FAUX_MODEL, context).result();

    assert.equal(expected.stopReason, "stop");
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(
      result.content.filter((block) => block.type === "text"),
      [{ type: "text", text: "Echo: ping" }],
    );
    // The upstream core accounts for every system instruction and tool declaration.
    assert.equal(result.usage.input, expected.usage.input);
    assert.equal(result.usage.cacheRead, 0);
    assert.equal(result.usage.cacheWrite, 0);
  });
}
