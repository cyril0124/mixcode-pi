import { getModel, type Model } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MixCodeTabInfo } from "../core/types.js";
import { resolveRegisteredModel } from "../core/models.js";
import { MIXCODE_FAUX_MODEL } from "./faux-stream.js";
import type { RuntimeModelRegistry } from "./runtime-types.js";

export function resolveRuntimeModel(
  provider: string,
  modelId: string,
  modelRegistry: RuntimeModelRegistry | undefined,
): Model<any> {
  if (provider === "faux") {
    const id = modelId ? modelId : MIXCODE_FAUX_MODEL.id;
    return { ...MIXCODE_FAUX_MODEL, id };
  }
  const registryModel = modelRegistry?.find?.(provider, modelId);
  if (registryModel) return registryModel;
  return resolveRegisteredModel(provider, modelId) ?? getModel(provider as never, modelId as never);
}

export function resolveRuntimeModelFromSession(
  session: SessionManager,
  fallback: MixCodeTabInfo["model"] | Model<any> | undefined,
  modelRegistry: RuntimeModelRegistry | undefined,
): Model<any> {
  const context = session.buildSessionContext();
  if (context.model) {
    return resolveRuntimeModel(context.model.provider, context.model.modelId, modelRegistry);
  }
  if (fallback && "provider" in fallback) {
    const modelId = "modelId" in fallback ? fallback.modelId : fallback.id;
    return resolveRuntimeModel(fallback.provider, modelId, modelRegistry);
  }
  return resolveRuntimeModel(MIXCODE_FAUX_MODEL.provider, MIXCODE_FAUX_MODEL.id, modelRegistry);
}
