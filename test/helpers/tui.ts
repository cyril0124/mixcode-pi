import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { OverlayTui } from "../../src/ui/app-types.js";

/**
 * Complete OverlayHandle stub. Production code (src/agent/runtime.ts) calls
 * isFocused()/isHidden()/focus() on stored handles, so a `{ hide }`-only
 * literal is not a valid stand-in.
 */
export function testOverlayHandle(hide: () => void = () => undefined): OverlayHandle {
  return {
    hide,
    setHidden: () => undefined,
    isHidden: () => false,
    focus: () => undefined,
    unfocus: () => undefined,
    isFocused: () => false,
  };
}

/**
 * Minimal conforming OverlayTui for tests. Overrides replace defaults, so a
 * test that only counts renders passes `{ requestRender }` and still satisfies
 * the mandatory `showOverlay` member.
 */
export function testTui(overrides: Partial<OverlayTui> = {}): OverlayTui {
  return {
    requestRender: () => undefined,
    showOverlay: () => testOverlayHandle(),
    ...overrides,
  };
}
