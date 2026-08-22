import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { CallRenderer } from "./tool-execution-adapter.js";

const innerCallComponentByWrapper = new WeakMap<Component, Component>();

/**
 * Preserve the selected renderer and its previous-component contract, then
 * optionally append raw JSON arguments as a display-only debugging block.
 */
export function wrapToolCallRenderer(
  toolName: string,
  selected: CallRenderer | undefined,
  showRawToolArguments: boolean,
): CallRenderer {
  return (args, theme, context) => {
    const previous = context.lastComponent;
    const previousInner = previous
      ? (innerCallComponentByWrapper.get(previous) ?? previous)
      : undefined;
    const innerContext = { ...context, lastComponent: previousInner };
    const inner = selected
      ? selected(args, theme, innerContext)
      : new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
    const wrapper = new Container();
    wrapper.addChild(inner);

    if (showRawToolArguments) {
      const serialized = JSON.stringify(args, null, 2);
      if (serialized) {
        wrapper.addChild(new Spacer(1));
        wrapper.addChild(new Text(theme.fg("toolOutput", serialized), 0, 0));
      }
    }

    innerCallComponentByWrapper.set(wrapper, inner);
    return wrapper;
  };
}
