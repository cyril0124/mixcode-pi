import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
} from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  LoginDialogComponent,
  OAuthSelectorComponent,
  ExtensionSelectorComponent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { applyMixCodeKeybindings } from "../agent/runtime-pi-tui-bridge.js";
import { ensureExtensionThemeInitialized } from "../agent/runtime-extension-theme.js";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { reloadRuntimeModels } from "./app-actions.js";
import type { MixCodeState } from "../core/types.js";
import { pushToast } from "../core/toast.js";
import { getActiveTab } from "../core/tabs.js";
import type { AuthInputHost } from "./app-types.js";

type AuthSelectorProvider = {
  id: string;
  name: string;
  authType: AuthType;
};

/**
 * Open /login flow: replace input area with provider selector → auth type → OAuth or API key input.
 * Matches Pi agent's editorContainer pattern.
 */
export async function openPiLogin(
  state: MixCodeState,
  runtime: Pick<
    MixCodeRuntime,
    | "getSharedModelRuntime"
    | "reloadModelConfig"
    | "resolveModel"
    | "updateTabModel"
  >,
  inputHost: AuthInputHost | undefined,
  providerRef?: string,
): Promise<void> {
  const modelRuntime = runtime.getSharedModelRuntime();
  const active = getActiveTab(state);

  if (!modelRuntime) {
    pushToast(state.tabs[0], { type: "error", message: "Auth not available (no model runtime)" });
    return;
  }

  if (!inputHost) {
    pushToast(state.tabs[0], { type: "error", message: "Auth UI not available" });
    return;
  }

  ensureExtensionThemeInitialized();
  const restoreKeys = applyMixCodeKeybindings();

  try {
    const providers = await getLoginProviders(modelRuntime);
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
      selectedProvider = await showProviderSelector(inputHost, "login", providers);
      if (!selectedProvider) return;
    }

    await performLogin(inputHost, modelRuntime, selectedProvider);

    await reloadRuntimeModels(state, runtime);
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
  runtime: Pick<
    MixCodeRuntime,
    | "getSharedModelRuntime"
    | "reloadModelConfig"
    | "resolveModel"
    | "updateTabModel"
  >,
  inputHost: AuthInputHost | undefined,
): Promise<void> {
  const modelRuntime = runtime.getSharedModelRuntime();
  const active = getActiveTab(state);

  if (!modelRuntime) {
    pushToast(state.tabs[0], { type: "error", message: "Auth not available (no model runtime)" });
    return;
  }

  if (!inputHost) {
    pushToast(state.tabs[0], { type: "error", message: "Auth UI not available" });
    return;
  }

  ensureExtensionThemeInitialized();
  const restoreKeys = applyMixCodeKeybindings();

  try {
    const providers = await getLogoutProviders(modelRuntime);
    if (providers.length === 0) {
      pushToast(state.tabs[0], { type: "warning", message: "No stored credentials to logout" });
      return;
    }

    const selected = await showProviderSelector(inputHost, "logout", providers);
    if (!selected) return;

    await modelRuntime.logout(selected.id);
    await reloadRuntimeModels(state, runtime);
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

async function getLoginProviders(modelRuntime: ModelRuntime): Promise<AuthSelectorProvider[]> {
  const providers: AuthSelectorProvider[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const auth = provider.auth;
    if (!auth) continue;
    if (auth.oauth?.login) {
      providers.push({
        id: provider.id,
        name: auth.oauth.name || provider.name || provider.id,
        authType: "oauth",
      });
    }
    if (auth.apiKey?.login) {
      providers.push({
        id: provider.id,
        name: auth.apiKey.name || provider.name || provider.id,
        authType: "api_key",
      });
    }
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

async function getLogoutProviders(modelRuntime: ModelRuntime): Promise<AuthSelectorProvider[]> {
  const stored = await modelRuntime.listCredentials();
  return stored
    .map((credential) => ({
      id: credential.providerId,
      name: modelRuntime.getProvider(credential.providerId)?.name ?? credential.providerId,
      authType: credential.type,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function showProviderSelector(
  inputHost: AuthInputHost,
  mode: "login" | "logout",
  providers: AuthSelectorProvider[],
): Promise<AuthSelectorProvider | undefined> {
  return new Promise((resolve) => {
    const selector = new OAuthSelectorComponent(
      mode,
      providers,
      (id, authType) => {
        const selected = providers.find((p) => p.id === id && p.authType === authType);
        inputHost.clearInputComponent();
        resolve(selected);
      },
      () => {
        inputHost.clearInputComponent();
        resolve(undefined);
      },
    );
    inputHost.setInputComponent(selector);
    selector.focused = true;
  });
}

async function performLogin(
  inputHost: AuthInputHost,
  modelRuntime: ModelRuntime,
  provider: AuthSelectorProvider,
): Promise<void> {
  const tui = { requestRender: () => inputHost.requestRender() } as TUI;
  const { promise: cancelled, reject: rejectLogin } = Promise.withResolvers<never>();
  const dialog = new LoginDialogComponent(
    tui,
    provider.id,
    (success, message) => {
      if (!success) rejectLogin(new Error(message ?? "Login cancelled"));
    },
    provider.name,
    provider.authType === "api_key" ? `${provider.name} API key` : undefined,
  );
  inputHost.setInputComponent(dialog);
  dialog.focused = true;

  const interaction: AuthInteraction = {
    signal: dialog.signal,
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type === "select") {
        const selected = await showOAuthMethodSelector(
          inputHost,
          prompt.message,
          prompt.options.map((option) => ({ id: option.id, label: option.label })),
        );
        if (!selected) throw new Error("Login cancelled");
        inputHost.setInputComponent(dialog);
        dialog.focused = true;
        return selected;
      }
      if (prompt.type === "manual_code") {
        return dialog.showManualInput(prompt.message);
      }
      return dialog.showPrompt(prompt.message, prompt.placeholder);
    },
    notify: (event: AuthEvent) => {
      if (event.type === "auth_url") {
        dialog.showAuth(event.url, event.instructions);
        return;
      }
      if (event.type === "device_code") {
        dialog.showDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
        return;
      }
      if (event.type === "progress") {
        dialog.showProgress(event.message);
        return;
      }
      if (event.type === "info") {
        dialog.showInfo(event.message, event.links);
      }
    },
  };

  await Promise.race([
    modelRuntime.login(provider.id, provider.authType, interaction),
    cancelled,
  ]);
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
