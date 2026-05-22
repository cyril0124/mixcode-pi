import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MixCodeTabInfo } from "./types.js";

export interface ToastNotification {
  message: string;
  createdAt: number;
}

const TOAST_DURATION_MS = 3_000;

export function pushToast(tab: MixCodeTabInfo, message: string): void {
  tab.toast = { message, createdAt: Date.now() };
}

export function activeToast(tab: MixCodeTabInfo): ToastNotification | undefined {
  if (!tab.toast) return undefined;
  if (Date.now() - tab.toast.createdAt > TOAST_DURATION_MS) {
    tab.toast = undefined;
    return undefined;
  }
  return tab.toast;
}

export function renderToast(
  tab: MixCodeTabInfo,
  width: number,
  dim: (text: string) => string,
): string | undefined {
  const toast = activeToast(tab);
  if (!toast) return undefined;
  const maxWidth = Math.min(40, Math.max(12, Math.floor(width * 0.4)));
  const text = truncateToWidth(toast.message, maxWidth - 2, "…");
  const padded = ` ${text} `;
  const paddedWidth = visibleWidth(padded);
  const leftPad = Math.max(0, width - paddedWidth);
  return `${" ".repeat(leftPad)}${dim(padded)}`;
}
