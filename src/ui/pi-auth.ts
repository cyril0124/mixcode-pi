import type {
  ApiKeyAuth,
  AuthCheck,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  OAuthAuth,
} from "@earendil-works/pi-ai";
import { fuzzyFilter, type TUI } from "@earendil-works/pi-tui";
import {
  CredentialSynchronizationError,
  LoginDialogComponent,
  OAuthSelectorComponent,
  ExtensionSelectorComponent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { applyMixCodeKeybindings } from "../agent/runtime-pi-tui-bridge.js";
import { ensureExtensionThemeInitialized } from "../agent/runtime-extension-theme.js";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { defaultPiAuthPath } from "../core/pi-models.js";
import { getActiveTab } from "../core/tabs.js";
import { pushToast, type ToastRequest } from "../core/toast.js";
import type { MixCodeState, MixCodeTabInfo } from "../core/types.js";
import { reloadRuntimeModels } from "./app-actions.js";
import type { AuthInputHost } from "./app-types.js";

type AuthSelectorProvider = {
  id: string;
  name: string;
  authType: AuthType;
  method?: ApiKeyAuth | OAuthAuth;
  status?: AuthCheck;
};

type AuthRuntime = Pick<
  MixCodeRuntime,
  | "getSharedModelRuntime"
  | "reloadModelConfig"
  | "refreshScopedModels"
  | "resolveModel"
  | "updateTabModel"
>;

type ArgumentCompletion = { value: string; label: string; description?: string };
type LoginCompletionProvider = { id: string; name: string; authTypes: AuthType[] };

const AUTH_TIMEOUT_MS = 15_000;
const ACCOUNT_LOGIN_LABEL = "Sign in with an account";
const API_KEY_LOGIN_LABEL = "Sign in with an API key";
const AUTH_TYPE_ORDER: Record<AuthType, number> = { oauth: 0, api_key: 1 };

/** /login and /logout can run from Home, where no tab-owned toast surface exists. */
function notifyTab(tab: MixCodeTabInfo | undefined, toast: ToastRequest): void {
  if (tab) pushToast(tab, toast);
}

export function loginArgumentCompletions(
  modelRuntime: ModelRuntime | undefined,
  prefix: string,
): ArgumentCompletion[] {
  if (!modelRuntime) return [];
  const providers = getLoginProviderCompletionOptions(getLoginProviders(modelRuntime));
  return fuzzyFilter(providers, prefix, getLoginProviderSearchText).map((provider) => ({
    value: provider.id,
    label: provider.id,
    description: formatLoginProviderCompletionDescription(provider),
  }));
}

/** Matches Pi's auth-type → provider → credential flow using Pi's public TUI components. */
export async function openPiLogin(
  state: MixCodeState,
  runtime: AuthRuntime,
  inputHost: AuthInputHost | undefined,
  providerRef?: string,
): Promise<void> {
  const modelRuntime = runtime.getSharedModelRuntime();
  const active = getActiveTab(state);
  if (!modelRuntime) {
    notifyTab(active, { type: "error", message: "Auth not available (no model runtime)" });
    return;
  }
  if (!inputHost) {
    notifyTab(active, { type: "error", message: "Auth UI not available" });
    return;
  }

  ensureExtensionThemeInitialized();
  const restoreKeys = applyMixCodeKeybindings();
  const sessionId = active?.sessionId;
  try {
    const selected = await selectLoginProvider(
      inputHost,
      modelRuntime,
      sessionId,
      providerRef,
      (message) => notifyTab(active, { type: "warning", message }),
    );
    if (!selected) return;

    if (selected.authType === "api_key" && !selected.method?.login) {
      await showAmbientAuthDialog(inputHost, selected, sessionId);
      return;
    }

    await performLogin(inputHost, modelRuntime, selected, sessionId);
    const actionLabel =
      selected.authType === "oauth"
        ? `Logged in to ${selected.name}`
        : `Saved API key for ${selected.name}`;
    await reloadRuntimeModels(state, runtime);
    notifyTab(active, {
      type: "success",
      message: `${actionLabel}. Credentials saved to ${defaultPiAuthPath()}`,
    });
    refreshProviderCatalog(modelRuntime, selected.id, actionLabel, state, runtime, active);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Login cancelled") {
      notifyTab(active, {
        type: "error",
        message:
          error instanceof CredentialSynchronizationError
            ? `Credentials saved, but local model state could not be synchronized: ${message}`
            : `Login failed: ${message}`,
      });
    }
  } finally {
    restoreKeys();
    inputHost.clearInputComponent(sessionId);
  }
}

export async function openPiLogout(
  state: MixCodeState,
  runtime: AuthRuntime,
  inputHost: AuthInputHost | undefined,
): Promise<void> {
  const modelRuntime = runtime.getSharedModelRuntime();
  const active = getActiveTab(state);
  if (!modelRuntime) {
    notifyTab(active, { type: "error", message: "Auth not available (no model runtime)" });
    return;
  }
  if (!inputHost) {
    notifyTab(active, { type: "error", message: "Auth UI not available" });
    return;
  }

  ensureExtensionThemeInitialized();
  const restoreKeys = applyMixCodeKeybindings();
  const sessionId = active?.sessionId;
  try {
    const providers = await getLogoutProviders(modelRuntime);
    if (providers.length === 0) {
      throw new Error("Error: No stored credentials to remove.");
    }
    const selected = await showProviderSelector(inputHost, "logout", providers, sessionId);
    if (!selected) return;

    await modelRuntime.logout(selected.id, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
    await reloadRuntimeModels(state, runtime);
    notifyTab(active, {
      type: "success",
      message:
        selected.authType === "oauth"
          ? `Logged out of ${selected.name}`
          : `Removed stored API key for ${selected.name}. Environment variables and models.json config are unchanged.`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Error:")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    notifyTab(active, {
      type: "error",
      message:
        error instanceof CredentialSynchronizationError
          ? `Credentials removed, but local model state could not be synchronized: ${message}`
          : `Logout failed: ${message}`,
    });
  } finally {
    restoreKeys();
    inputHost.clearInputComponent(sessionId);
  }
}

function getLoginProviderCompletionOptions(
  providerOptions: AuthSelectorProvider[],
): LoginCompletionProvider[] {
  const byId = new Map<string, LoginCompletionProvider>();
  for (const provider of providerOptions) {
    const existing = byId.get(provider.id);
    if (existing) {
      if (!existing.authTypes.includes(provider.authType)) {
        existing.authTypes.push(provider.authType);
        existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
      }
      continue;
    }
    byId.set(provider.id, {
      id: provider.id,
      name: provider.name,
      authTypes: [provider.authType],
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getLoginProviderSearchText(provider: LoginCompletionProvider): string {
  const authTypes = provider.authTypes
    .map((authType) => `${authType} ${formatAuthType(authType)}`)
    .join(" ");
  return `${provider.id} ${provider.name} ${authTypes}`;
}

function formatLoginProviderCompletionDescription(provider: LoginCompletionProvider): string {
  const authTypes = provider.authTypes.map(formatAuthType).join("/");
  return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

function formatAuthType(authType: AuthType): string {
  return authType === "oauth" ? "subscription" : "API key";
}

async function selectLoginProvider(
  inputHost: AuthInputHost,
  modelRuntime: ModelRuntime,
  sessionId: string | undefined,
  providerRef: string | undefined,
  warn: (message: string) => void,
): Promise<AuthSelectorProvider | undefined> {
  const providers = getLoginProviders(modelRuntime);
  const normalized = providerRef?.trim().toLowerCase();
  if (normalized) {
    const matches = providers.filter(
      (provider) =>
        provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && new Set(matches.map((provider) => provider.id)).size === 1) {
      const authType = await showAuthTypeSelector(inputHost, matches, sessionId);
      return matches.find((provider) => provider.authType === authType);
    }
    if (providers.length === 0) {
      warn("No login providers available.");
      return undefined;
    }
    return showProviderSelector(inputHost, "login", providers, sessionId, providerRef?.trim());
  }

  const authType = await showAuthTypeSelector(inputHost, undefined, sessionId);
  if (!authType) return undefined;
  const typedProviders = providers.filter((provider) => provider.authType === authType);
  if (typedProviders.length === 0) {
    warn(
      authType === "oauth"
        ? "No subscription providers available."
        : "No API key providers available.",
    );
    return undefined;
  }
  return showProviderSelector(inputHost, "login", typedProviders, sessionId);
}

function getLoginProviders(modelRuntime: ModelRuntime): AuthSelectorProvider[] {
  const providers: AuthSelectorProvider[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const authStatus = modelRuntime.getProviderAuthStatus(provider.id);
    const status: AuthCheck | undefined = authStatus.configured
      ? {
          type: modelRuntime.isUsingOAuth(provider.id) ? "oauth" : "api_key",
          source: authStatus.label ?? authStatus.source,
        }
      : undefined;
    if (provider.auth.oauth) {
      providers.push({
        id: provider.id,
        name: provider.name,
        authType: "oauth",
        method: provider.auth.oauth,
        status,
      });
    }
    if (provider.auth.apiKey) {
      providers.push({
        id: provider.id,
        name: provider.name,
        authType: "api_key",
        method: provider.auth.apiKey,
        status,
      });
    }
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

async function getLogoutProviders(modelRuntime: ModelRuntime): Promise<AuthSelectorProvider[]> {
  return (await modelRuntime.listCredentials({ signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }))
    .map((credential) => {
      const provider = modelRuntime.getProvider(credential.providerId);
      return {
        id: credential.providerId,
        name: provider?.name ?? credential.providerId,
        authType: credential.type,
        method: credential.type === "oauth" ? provider?.auth.oauth : provider?.auth.apiKey,
        status: { type: credential.type, source: "stored credential" },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function showAuthTypeSelector(
  inputHost: AuthInputHost,
  providers: AuthSelectorProvider[] | undefined,
  sessionId: string | undefined,
): Promise<AuthType | undefined> {
  const oauth = providers?.find((provider) => provider.authType === "oauth");
  const oauthLabel =
    oauth?.method && "loginLabel" in oauth.method
      ? (oauth.method.loginLabel ?? ACCOUNT_LOGIN_LABEL)
      : ACCOUNT_LOGIN_LABEL;
  const available = providers
    ? new Set(providers.map((provider) => provider.authType))
    : new Set<AuthType>(["oauth", "api_key"]);
  const choices = [
    ...(available.has("oauth") ? [{ label: oauthLabel, type: "oauth" as const }] : []),
    ...(available.has("api_key") ? [{ label: API_KEY_LOGIN_LABEL, type: "api_key" as const }] : []),
  ];
  if (choices.length === 1) return Promise.resolve(choices[0]!.type);

  return new Promise((resolve) => {
    const selector = new ExtensionSelectorComponent(
      providers?.[0]
        ? `Select authentication method for ${providers[0].name}:`
        : "Select authentication method:",
      choices.map((choice) => choice.label),
      (label) => {
        inputHost.clearInputComponent(sessionId);
        resolve(choices.find((choice) => choice.label === label)?.type);
      },
      () => {
        inputHost.clearInputComponent(sessionId);
        resolve(undefined);
      },
    );
    inputHost.setInputComponent(selector, sessionId);
  });
}

function showProviderSelector(
  inputHost: AuthInputHost,
  mode: "login" | "logout",
  providers: AuthSelectorProvider[],
  sessionId: string | undefined,
  initialSearchInput?: string,
): Promise<AuthSelectorProvider | undefined> {
  return new Promise((resolve) => {
    const selector = new OAuthSelectorComponent(
      mode,
      providers,
      (id, authType) => {
        inputHost.clearInputComponent(sessionId);
        resolve(providers.find((provider) => provider.id === id && provider.authType === authType));
      },
      () => {
        inputHost.clearInputComponent(sessionId);
        resolve(undefined);
      },
      initialSearchInput,
    );
    inputHost.setInputComponent(selector, sessionId);
    selector.focused = true;
  });
}

function showAmbientAuthDialog(
  inputHost: AuthInputHost,
  provider: AuthSelectorProvider,
  sessionId: string | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const dialog = new LoginDialogComponent(
      tuiStub(inputHost),
      provider.id,
      () => resolve(),
      provider.name,
      `${provider.name} setup`,
    );
    dialog.showInfo(
      `${provider.method?.name ?? "Authentication"} is configured outside MixCode.`,
      [],
      true,
    );
    inputHost.setInputComponent(dialog, sessionId);
    dialog.focused = true;
  });
}

async function performLogin(
  inputHost: AuthInputHost,
  modelRuntime: ModelRuntime,
  provider: AuthSelectorProvider,
  sessionId: string | undefined,
): Promise<void> {
  const { promise: cancelled, reject: rejectLogin } = Promise.withResolvers<never>();
  const dialog = new LoginDialogComponent(
    tuiStub(inputHost),
    provider.id,
    (success, message) => {
      if (!success) rejectLogin(new Error(message ?? "Login cancelled"));
    },
    provider.name,
  );
  inputHost.setInputComponent(dialog, sessionId);
  dialog.focused = true;
  const interaction: AuthInteraction = {
    signal: dialog.signal,
    prompt: (prompt) => showAuthPrompt(inputHost, dialog, prompt, sessionId),
    notify: (event) => notifyAuthDialog(dialog, event),
  };
  await Promise.race([modelRuntime.login(provider.id, provider.authType, interaction), cancelled]);
}

async function showAuthPrompt(
  inputHost: AuthInputHost,
  dialog: LoginDialogComponent,
  prompt: AuthPrompt,
  sessionId: string | undefined,
): Promise<string> {
  let response: Promise<string>;
  if (prompt.type === "select") {
    response = showOAuthMethodSelector(
      inputHost,
      dialog,
      prompt.message,
      prompt.options.map((option) => ({ id: option.id, label: option.label })),
      sessionId,
    );
  } else if (prompt.type === "manual_code") {
    response = dialog.showManualInput(prompt.message);
  } else {
    response = dialog.showPrompt(prompt.message, prompt.placeholder);
  }
  if (!prompt.signal) return response;
  if (prompt.signal.aborted) throw new Error("Login cancelled");
  const signal = prompt.signal;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(new Error("Login cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([response, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function showOAuthMethodSelector(
  inputHost: AuthInputHost,
  dialog: LoginDialogComponent,
  message: string,
  options: Array<{ id: string; label: string }>,
  sessionId: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const restoreDialog = () => {
      inputHost.setInputComponent(dialog, sessionId);
      dialog.focused = true;
    };
    const selector = new ExtensionSelectorComponent(
      message,
      options.map((option) => option.label),
      (label) => {
        restoreDialog();
        const id = options.find((option) => option.label === label)?.id;
        if (id) resolve(id);
        else reject(new Error("Login cancelled"));
      },
      () => {
        restoreDialog();
        reject(new Error("Login cancelled"));
      },
    );
    inputHost.setInputComponent(selector, sessionId);
  });
}

function notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
  if (event.type === "auth_url") {
    dialog.showAuth(event.url, event.instructions);
  } else if (event.type === "device_code") {
    dialog.showDeviceCode(event);
    dialog.showWaiting("Waiting for authentication...");
  } else if (event.type === "info") {
    dialog.showInfo(event.message, event.links);
  } else {
    dialog.showProgress(event.message);
  }
}

function refreshProviderCatalog(
  modelRuntime: ModelRuntime,
  providerId: string,
  actionLabel: string,
  state: MixCodeState,
  runtime: AuthRuntime,
  tab: MixCodeTabInfo | undefined,
): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  void modelRuntime
    .refresh({ providers: [providerId], signal: controller.signal })
    .then(async (result) => {
      if (result.aborted) {
        notifyTab(tab, {
          type: "warning",
          message: `${actionLabel}, but its model catalog refresh timed out; using cached models.`,
        });
      } else if (result.errors.size > 0) {
        notifyTab(tab, {
          type: "warning",
          message: `${actionLabel}, but its model catalog could not be refreshed; using cached models.`,
        });
      }
      await reloadRuntimeModels(state, runtime);
    })
    .catch((error) => {
      notifyTab(tab, {
        type: "warning",
        message: `${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
      });
    })
    .finally(() => clearTimeout(timeout));
}

function tuiStub(inputHost: AuthInputHost): TUI {
  return { requestRender: () => inputHost.requestRender() } as TUI;
}
