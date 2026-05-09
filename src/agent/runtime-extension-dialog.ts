import { createQuestionRequest } from "../core/questions.js";
import type { RuntimeTab } from "./runtime-types.js";

export function createExtensionDialog(
  runtimeTab: RuntimeTab,
  requestRender: () => void,
  kind: "select" | "confirm" | "input",
  title: string,
  question: string,
  options: Array<{ label: string; description: string }>,
  multiple: boolean,
  custom: boolean,
  opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string | undefined> {
  const requestId = `extension-ui-${kind}-${Date.now()}-${runtimeTab.extensionDialogResolvers.size + 1}`;
  const request = createQuestionRequest(
    requestId,
    runtimeTab.tab.sessionId,
    [
      {
        header: title,
        question,
        options,
        multiple,
        custom,
      },
    ],
    {
      extensionResolverId: requestId,
      extensionUiKind: kind,
    },
  );
  if (kind === "input") {
    request.highlightedOptionIndices[0] = 0;
    request.editingCustomIndex = 0;
  }
  runtimeTab.tab.pendingQuestions.push(request);
  requestRender();
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: string | boolean | undefined) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", abort);
      runtimeTab.extensionDialogResolvers.delete(requestId);
      removePendingQuestion(runtimeTab, requestId);
      resolve(typeof result === "string" ? result : undefined);
      requestRender();
    };
    const abort = () => finish(undefined);
    runtimeTab.extensionDialogResolvers.set(requestId, finish);
    if (opts?.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }
    if (opts?.timeout !== undefined) {
      timeout = setTimeout(() => finish(undefined), Math.max(0, opts.timeout));
      timeout.unref?.();
    }
  });
}

function removePendingQuestion(runtimeTab: RuntimeTab, requestId: string): void {
  const index = runtimeTab.tab.pendingQuestions.findIndex(
    (request) => request.requestId === requestId,
  );
  if (index !== -1) runtimeTab.tab.pendingQuestions.splice(index, 1);
}
