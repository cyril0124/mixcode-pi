import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveRegisteredModel } from "../core/models.js";
import type { MixCodeModel, MixCodeTabInfo } from "../core/types.js";
import { MIXCODE_FAUX_MODEL } from "./faux-stream.js";
import type { RuntimeModelRegistry } from "./runtime-types.js";

type ModelLookup = RuntimeModelRegistry | ModelRuntime | undefined;

function findModel(lookup: ModelLookup, provider: string, modelId: string) {
  if (!lookup) return undefined;
  if ("find" in lookup && typeof lookup.find === "function") {
    return lookup.find(provider, modelId);
  }
  if ("getModel" in lookup && typeof lookup.getModel === "function") {
    return lookup.getModel(provider, modelId);
  }
  return undefined;
}

export function resolveRuntimeModel(
  provider: string,
  modelId: string,
  modelLookup: ModelLookup,
): MixCodeModel {
  if (provider === "faux") {
    const id = modelId ? modelId : MIXCODE_FAUX_MODEL.id;
    return { ...MIXCODE_FAUX_MODEL, id };
  }
  const registryModel = findModel(modelLookup, provider, modelId);
  if (registryModel) return registryModel;
  return resolveRegisteredModel(provider, modelId) ?? getBuiltinModel(provider as never, modelId as never);
}

export function resolveRuntimeModelFromSession(
  session: SessionManager,
  fallback: MixCodeTabInfo["model"] | MixCodeModel | undefined,
  modelLookup: ModelLookup,
): MixCodeModel {
  const context = session.buildSessionContext();
  if (context.model) {
    const restored = resolveRuntimeModel(
      context.model.provider,
      context.model.modelId,
      modelLookup,
    );
    if (restored) return restored;
  }
  if (fallback && "provider" in fallback) {
    const modelId = "modelId" in fallback ? fallback.modelId : fallback.id;
    const fromFallback = resolveRuntimeModel(fallback.provider, modelId, modelLookup);
    if (fromFallback) return fromFallback;
  }
  return resolveRuntimeModel(MIXCODE_FAUX_MODEL.provider, MIXCODE_FAUX_MODEL.id, modelLookup);
}
