import type { ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionForkOptions,
  ExtensionNavigateTreeOptions,
  ExtensionNewSessionOptions,
  ExtensionSwitchSessionOptions,
  RuntimeTab,
} from "./runtime-types.js";

interface ExtensionCommandRuntime {
  extensionNewSession(
    sourceSessionId: string,
    options?: ExtensionNewSessionOptions,
  ): ReturnType<ExtensionCommandContextActions["newSession"]>;
  extensionFork(
    sourceSessionId: string,
    entryId: string,
    options?: ExtensionForkOptions,
  ): ReturnType<ExtensionCommandContextActions["fork"]>;
  extensionNavigateTree(
    sourceSessionId: string,
    targetId: string,
    options?: ExtensionNavigateTreeOptions,
  ): ReturnType<ExtensionCommandContextActions["navigateTree"]>;
  extensionSwitchSession(
    sourceSessionId: string,
    sessionPath: string,
    options?: ExtensionSwitchSessionOptions,
  ): ReturnType<ExtensionCommandContextActions["switchSession"]>;
  extensionReload(sessionId: string): Promise<void>;
}

export function createExtensionCommandActions(
  runtime: ExtensionCommandRuntime,
  runtimeTab: RuntimeTab,
): ExtensionCommandContextActions {
  return {
    waitForIdle: () => runtimeTab.agentSession.agent.waitForIdle(),
    newSession: (options) => runtime.extensionNewSession(runtimeTab.tab.sessionId, options),
    fork: (entryId, options) => runtime.extensionFork(runtimeTab.tab.sessionId, entryId, options),
    navigateTree: (targetId, options) =>
      runtime.extensionNavigateTree(runtimeTab.tab.sessionId, targetId, options),
    switchSession: (sessionPath, options) =>
      runtime.extensionSwitchSession(runtimeTab.tab.sessionId, sessionPath, options),
    reload: () => runtime.extensionReload(runtimeTab.tab.sessionId),
  };
}
