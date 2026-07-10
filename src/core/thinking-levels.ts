import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeModel, MixCodeModelRef } from "./types.js";

const DISCOVERY_THINKING_LEVEL_MAP = new Proxy(Object.create(null) as Record<string, string>, {
  get: (_target, property) => (typeof property === "string" ? property : undefined),
}) as Partial<Record<ModelThinkingLevel, string>>;

const DISCOVERY_MODEL: MixCodeModel = {
  id: "mixcode-thinking-discovery",
  name: "MixCode Thinking Discovery",
  api: "mixcode-thinking-discovery",
  provider: "mixcode",
  baseUrl: "local://mixcode-thinking-discovery",
  reasoning: true,
  thinkingLevelMap: DISCOVERY_THINKING_LEVEL_MAP,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
};

export function allKnownThinkingLevels(): ThinkingLevel[] {
  return getSupportedThinkingLevels(DISCOVERY_MODEL) as ThinkingLevel[];
}

export function availableThinkingLevelsForModel(model: MixCodeModelRef | MixCodeModel | undefined): ThinkingLevel[] {
  if (!model) return allKnownThinkingLevels();
  return getSupportedThinkingLevels(toCapabilityModel(model)) as ThinkingLevel[];
}

export function isKnownThinkingLevel(value: string): value is ThinkingLevel {
  return allKnownThinkingLevels().includes(value as ThinkingLevel);
}

export function isThinkingLevelAvailable(
  value: string,
  model: MixCodeModelRef | MixCodeModel | undefined,
): value is ThinkingLevel {
  return availableThinkingLevelsForModel(model).includes(value as ThinkingLevel);
}

export function validThinkingLevelsMessage(model: MixCodeModelRef | MixCodeModel | undefined): string {
  return availableThinkingLevelsForModel(model).join(", ");
}

function toCapabilityModel(model: MixCodeModelRef | MixCodeModel): MixCodeModel {
  if ("id" in model) return model;
  return {
    ...DISCOVERY_MODEL,
    id: model.modelId,
    name: model.displayName,
    provider: model.provider,
    reasoning: model.reasoning ?? false,
    thinkingLevelMap: model.thinkingLevelMap as Partial<Record<ModelThinkingLevel, string | null>> | undefined,
    contextWindow: model.contextWindow,
  };
}
