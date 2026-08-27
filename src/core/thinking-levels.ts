import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeModel, MixCodeModelRef } from "./types.js";

// Closed Pi ModelThinkingLevel set. getSupportedThinkingLevels is unexported-list + filter.
const ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export function allKnownThinkingLevels(): ThinkingLevel[] {
  return [...ALL_THINKING_LEVELS] as ThinkingLevel[];
}

export function availableThinkingLevelsForModel(
  model: MixCodeModelRef | MixCodeModel | undefined,
): ThinkingLevel[] {
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

export function validThinkingLevelsMessage(
  model: MixCodeModelRef | MixCodeModel | undefined,
): string {
  return availableThinkingLevelsForModel(model).join(", ");
}

function toCapabilityModel(model: MixCodeModelRef | MixCodeModel): MixCodeModel {
  if ("id" in model) return model;
  return {
    id: model.modelId,
    name: model.displayName,
    api: "mixcode-thinking-discovery",
    provider: model.provider,
    baseUrl: "local://mixcode-thinking-discovery",
    reasoning: model.reasoning ?? false,
    thinkingLevelMap: model.thinkingLevelMap as
      | Partial<Record<ModelThinkingLevel, string | null>>
      | undefined,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: 1,
  };
}
