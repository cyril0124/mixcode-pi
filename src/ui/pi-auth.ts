import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  LoginDialogComponent,
  OAuthSelectorComponent,
  ExtensionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { applyMixCodeKeybindings } from "../agent/runtime-pi-tui-bridge.js";
import { ensureExtensionThemeInitialized } from "../agent/runtime-extension-theme.js";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { RuntimeModelRegistry } from "../agent/runtime-types.js";
import { reloadRuntimeModels } from "./app-actions.js";
import type { MixCodeState } from "../core/types.js";
import { pushToast } from "../core/toast.js";
import { getActiveTab } from "../core/tabs.js";
import type { AuthInputHost } from "./app-submit.js";

type AuthSelectorProvider = {
  id: string;
  name: string;
  authType: "oauth" | "api_key";
};

/**
 * Open /login flow: replace input area with provider selector → auth type → OAuth or API key input.
 * Matches Pi agent's editorContainer pattern.
 */
export async function openPiLogin(
  state: MixCodeState,
  runtime: Partial<Pick<MixCodeRuntime, "getSharedModelRegistry" | "reloadModelConfig">>,
  inputHost: AuthInputHost | undefined,
  providerRef?: string,
): Promise<void> {
  const registry = runtime.getSharedModelRegistry?.();
  const active = getActiveTab(state);

  if (!registry) {
    pushToast(state.tabs[0], { type: "error", message: "Auth not available (no registry)" });
    return;
  }

  if (!inputHost) {
    pushToast(state.tabs[0], { type: "error", message: "Auth UI not available" });
    return;
  }

  ensureExtensionThemeInitialized();
  const restoreKeys = applyMixCodeKeybindings();

  try {
    const providers = getLoginProviders(registry);
    if (providers.length === 0) {
      pushToast(state.tabs[0], { type: "warning", message: "No login providers available" });
      return;
    }

    let selectedProvider: AuthSelectorProvider | undefined;

    if (providerRef) {
      const normalized = providerRef.toLowerCase();
      selectedProvider = providers.find(
        (p) => p.id.toLowerCase() === normalized || p.name.toLowerCase() === normalized,
      );
      if (!selectedProvider) {
        pushToast(state.tabs[0], {
          type: "error",
          message: `Provider not found: ${providerRef}`,
        });
        return;
      }
    } else {
      selectedProvider = await showProviderSelector(inputHost, "login", registry, providers);
      if (!selectedProvider) return;
    }

    if (selectedProvider.authType === "oauth") {
      await performOAuthLogin(inputHost, registry, selectedProvider.id, selectedProvider.name);
    } else {
      await performApiKeyLogin(inputHost, registry, selectedProvider.id, selectedProvider.name);
    }

    reloadRuntimeModels(state, runtime);
    pushToast(state.tabs[0], {
      type: "success",
      message: `Logged in to ${selectedProvider.name}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Login cancelled" && message !== "Cancelled") {
      pushToast(state.tabs[0], { type: "error", message: `Login failed: ${message}` });
    }
  } finally {
    restoreKeys();
    inputHost?.clearInputComponent(active?.sessionId);
  }
}

/**
 * Open /logout flow: replace input area with stored provider selector, remove credential.
 * Matches Pi agent's editorContainer pattern.
 */
export async function openPiLogout(
  state: MixCodeState,
  runtime: Partial<Pick<MixCodeRuntime, "getSharedModelRegistry" | "reloadModelConfig">>,
  inputHost: AuthInputHost | undefined,
): Promise<void> {
  const registry = runtime.getSharedModelRegistry?.();
  const active = getActiveTab(state);

  if (!registry) {
    pushToast(state.tabs[0], { type: "error", message: "Auth not available (no registry)" });
    return;
  }

  if (!inputHost) {
    pushToast(state.tabs[0], { type: "error", message: "Auth UI not available" });
    return;
  }

  ensureExtensionThemeInitialized();
  const restoreKeys = applyMixCodeKeybindings();

  try {
    const providers = getLogoutProviders(registry);
    if (providers.length === 0) {
      pushToast(state.tabs[0], { type: "warning", message: "No stored credentials to logout" });
      return;
    }

    const selected = await showProviderSelector(inputHost, "logout", registry, providers);
    if (!selected) return;

    registry.authStorage.logout(selected.id);
    reloadRuntimeModels(state, runtime);
    pushToast(state.tabs[0], {
      type: "success",
      message: `Logged out from ${selected.name}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Cancelled") {
      pushToast(state.tabs[0], { type: "error", message: `Logout failed: ${message}` });
    }
  } finally {
    restoreKeys();
    inputHost?.clearInputComponent(active?.sessionId);
  }
}

function getLoginProviders(registry: RuntimeModelRegistry): AuthSelectorProvider[] {
  const oauthProviders = registry.authStorage.getOAuthProviders();
  const apiKeyProviders = registry
    .getAll()
    .map((m) => m.provider)
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .filter((p) => !oauthProviders.some((o) => o.id === p));

  return [
    ...oauthProviders.map((p) => ({
      id: p.id,
      name: p.name,
      authType: "oauth" as const,
    })),
    ...apiKeyProviders.map((p) => ({
      id: p,
      name: registry.getProviderDisplayName(p),
      authType: "api_key" as const,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

function getLogoutProviders(registry: RuntimeModelRegistry): AuthSelectorProvider[] {
  const stored = registry.authStorage.list();
  const oauthIds = new Set(registry.authStorage.getOAuthProviders().map((p) => p.id));

  return stored
    .map((id) => ({
      id,
      name: registry.getProviderDisplayName(id),
      authType: (oauthIds.has(id) ? "oauth" : "api_key") as "oauth" | "api_key",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function showProviderSelector(
  inputHost: AuthInputHost,
  mode: "login" | "logout",
  registry: RuntimeModelRegistry,
  providers: AuthSelectorProvider[],
): Promise<AuthSelectorProvider | undefined> {
  return new Promise((resolve) => {
    const selector = new OAuthSelectorComponent(
      mode,
      registry.authStorage,
      providers,
      (id, _authType) => {
        const selected = providers.find((p) => p.id === id);
        inputHost.clearInputComponent();
        resolve(selected);
      },
      () => {
        inputHost.clearInputComponent();
        resolve(undefined);
      },
      (id) => registry.getProviderAuthStatus(id),
    );
    inputHost.setInputComponent(selector);
    selector.focused = true;
  });
}

async function performOAuthLogin(
  inputHost: AuthInputHost,
  registry: RuntimeModelRegistry,
  providerId: string,
  providerName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tui = { requestRender: () => inputHost.requestRender() } as TUI;
    const dialog = new LoginDialogComponent(
      tui,
      providerId,
      (success, message) => {
        if (success) resolve();
        else reject(new Error(message ?? "Login failed"));
      },
      providerName,
    );
    inputHost.setInputComponent(dialog);
    dialog.focused = true;

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => dialog.showAuth(info.url, info.instructions),
      onDeviceCode: (info) => dialog.showDeviceCode(info),
      onPrompt: (prompt) => dialog.showPrompt(prompt.message, prompt.placeholder),
      onProgress: (message) => dialog.showProgress(message),
      onSelect: async (prompt) => {
        const selected = await showOAuthMethodSelector(inputHost, prompt.message, prompt.options);
        if (!selected) throw new Error("Login cancelled");
        // Re-show dialog after method selection
        inputHost.setInputComponent(dialog);
        dialog.focused = true;
        return selected;
      },
      onManualCodeInput: () =>
        dialog.showManualInput("Paste the redirect URL or authorization code:"),
      signal: dialog.signal,
    };

    registry.authStorage.login(providerId, callbacks).catch(reject);
  });
}

async function performApiKeyLogin(
  inputHost: AuthInputHost,
  registry: RuntimeModelRegistry,
  providerId: string,
  providerName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tui = { requestRender: () => inputHost.requestRender() } as TUI;
    const dialog = new LoginDialogComponent(
      tui,
      providerId,
      (success, message) => {
        if (success) resolve();
        else reject(new Error(message ?? "Login cancelled"));
      },
      providerName,
      `${providerName} API key`,
    );
    inputHost.setInputComponent(dialog);
    dialog.focused = true;

    dialog
      .showPrompt("Enter your API key:", "sk-...")
      .then((apiKey) => {
        if (!apiKey || apiKey.trim().length === 0) {
          reject(new Error("API key cannot be empty"));
          return;
        }
        registry.authStorage.set(providerId, { type: "api_key", key: apiKey.trim() });
        resolve();
      })
      .catch(reject);
  });
}

async function showOAuthMethodSelector(
  inputHost: AuthInputHost,
  message: string,
  options: Array<{ id: string; label: string }>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const selector = new ExtensionSelectorComponent(
      message,
      options.map((opt) => opt.label),
      (selected) => {
        const index = options.findIndex((opt) => opt.label === selected);
        inputHost.clearInputComponent();
        resolve(index >= 0 ? options[index]!.id : undefined);
      },
      () => {
        inputHost.clearInputComponent();
        resolve(undefined);
      },
    );
    inputHost.setInputComponent(selector);
  });
}
