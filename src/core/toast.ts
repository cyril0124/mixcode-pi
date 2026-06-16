import type { MixCodeTabInfo } from "./types.js";

export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastNotification {
  type: ToastType;
  message: string;
  createdAt: number;
}

export interface ToastRequest {
  type: ToastType;
  message: string;
}

const TOAST_DURATION_MS = 3_000;

export function pushToast(tab: MixCodeTabInfo, toast: ToastRequest): void {
  tab.toast = { ...toast, createdAt: Date.now() };
}

export function activeToast(tab: MixCodeTabInfo): ToastNotification | undefined {
  if (!tab.toast) return undefined;
  if (Date.now() - tab.toast.createdAt > TOAST_DURATION_MS) {
    tab.toast = undefined;
    return undefined;
  }
  return tab.toast;
}
