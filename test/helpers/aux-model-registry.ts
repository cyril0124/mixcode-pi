import {
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type AssistantMessage,
  type CredentialStore,
  type Context,
  type Model,
  type ProviderAuth,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export type TestCompletion = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/** Create a registry with scripted provider authentication and responses. */
export async function createAuxModelRegistry(options: {
  complete: TestCompletion;
  models: readonly Pick<Model<string>, "provider" | "id">[];
  auth?: ProviderAuth;
  credentials?: CredentialStore;
}) {
  const credentials = options.credentials ?? new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    credentials,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  for (const providerId of new Set(options.models.map((model) => model.provider))) {
    const models: Model<string>[] = options.models
      .filter((model) => model.provider === providerId)
      .map((model) => ({
        api: "aux-test",
        name: model.id,
        baseUrl: "local://aux-test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
        ...model,
      }));
    const stream = (
      model: Model<string>,
      context: TranscriptContext,
      request?: SimpleStreamOptions,
    ) => {
      const core = createFauxCore({ api: model.api, provider: providerId });
      core.setResponses([
        async () => ({
          ...fauxAssistantMessage(""),
          ...(await options.complete(
            model,
            {
              systemPrompt: getCurrentSystemPrompt(context.messages),
              tools: getCurrentTools(context.messages),
              messages: context.messages.filter((message) => message.role !== "system"),
            },
            request,
          )),
        }),
      ]);
      return core.stream(model, context, request);
    };
    registry.registerProvider(
      createProvider({
        id: providerId,
        models,
        auth: options.auth ?? {
          apiKey: {
            name: "Offline test auth",
            resolve: async () => ({ auth: { apiKey: "offline-key" } }),
          },
        },
        api: { stream, streamSimple: stream },
      }),
    );
  }
  return { runtime, registry, credentials };
}
