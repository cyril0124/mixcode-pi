// Render-only ToolExecutionComponent adapter; license notices: ./THIRD_PARTY_NOTICES.md.
// This package keeps only guarded renderer/shell selection.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
export type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
export type RenderShell = NonNullable<ToolDefinition["renderShell"]>;

interface ToolRowHost {
  toolName?: string;
  invalidate?: () => void;
  toolDefinition?: { name?: string };
  builtInToolDefinition?: { name?: string };
}

type RendererSelector<T> = (this: ToolRowHost, ...args: unknown[]) => T | undefined;
type ShellSelector = (this: ToolRowHost, ...args: unknown[]) => RenderShell;

export interface ToolRowResolver {
  call(toolName: string, native: CallRenderer | undefined): CallRenderer | undefined;
  result(toolName: string, native: ResultRenderer | undefined): ResultRenderer | undefined;
  shell(toolName: string, native: RenderShell): RenderShell;
}

interface InstallationState {
  callDescriptor: PropertyDescriptor;
  resultDescriptor: PropertyDescriptor;
  shellDescriptor: PropertyDescriptor;
  patchedCall: RendererSelector<CallRenderer>;
  patchedResult: RendererSelector<ResultRenderer>;
  patchedShell: ShellSelector;
  resolver: ToolRowResolver;
  rows: Set<WeakRef<ToolRowHost>>;
  addedSinceSweep: number;
  owner: object;
  active: boolean;
}

const STATE = Symbol.for("mpi-tool-display.toolExecutionAdapter.v1");
type HostPrototype = ToolRowHost & {
  getCallRenderer?: RendererSelector<CallRenderer>;
  getResultRenderer?: RendererSelector<ResultRenderer>;
  getRenderShell?: ShellSelector;
  [STATE]?: InstallationState;
};

export interface ToolExecutionAdapterInstallation {
  dispose(): void;
}

function toolName(instance: ToolRowHost): string {
  return String(
    instance.toolDefinition?.name ??
      instance.builtInToolDefinition?.name ??
      instance.toolName ??
      "",
  );
}

// Sweeping after as many additions as tracked refs keeps sweep cost amortized
// O(1) per row while letting host-dropped rows be collected.
function sweepRows(state: InstallationState): void {
  const live = new Set<WeakRef<ToolRowHost>>();
  for (const ref of state.rows) {
    if (ref.deref()) live.add(ref);
  }
  state.rows = live;
  state.addedSinceSweep = 0;
}

function trackRow(state: InstallationState, row: ToolRowHost): void {
  state.rows.add(new WeakRef(row));
  if (state.addedSinceSweep++ > state.rows.size) sweepRows(state);
}

function invalidateRows(state: InstallationState): void {
  for (const ref of state.rows) {
    ref.deref()?.invalidate?.();
  }
}

function ownState(prototype: HostPrototype): InstallationState | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, STATE);
  return descriptor && "value" in descriptor
    ? (descriptor.value as InstallationState | undefined)
    : undefined;
}

function ownMethod(
  prototype: HostPrototype,
  key: "getCallRenderer" | "getResultRenderer" | "getRenderShell",
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function assertMethodDescriptor(prototype: HostPrototype, key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    descriptor.configurable !== true ||
    descriptor.writable !== true
  ) {
    throw new Error(
      `mpi-tool-display requires a writable ToolExecutionComponent.prototype.${key}()`,
    );
  }
  return descriptor;
}

function restore(prototype: HostPrototype, state: InstallationState): void {
  if (ownMethod(prototype, "getRenderShell") === state.patchedShell) {
    Object.defineProperty(prototype, "getRenderShell", state.shellDescriptor);
  }
  if (ownMethod(prototype, "getResultRenderer") === state.patchedResult) {
    Object.defineProperty(prototype, "getResultRenderer", state.resultDescriptor);
  }
  if (ownMethod(prototype, "getCallRenderer") === state.patchedCall) {
    Object.defineProperty(prototype, "getCallRenderer", state.callDescriptor);
  }
  if (
    ownMethod(prototype, "getCallRenderer") !== state.patchedCall &&
    ownMethod(prototype, "getResultRenderer") !== state.patchedResult &&
    ownMethod(prototype, "getRenderShell") !== state.patchedShell &&
    ownState(prototype) === state
  ) {
    delete prototype[STATE];
  }
}

function dispose(prototype: HostPrototype, state: InstallationState, owner: object): void {
  if (state.owner !== owner) return;
  state.active = false;
  state.rows.clear();
  restore(prototype, state);
}

/** Install a render-only adapter; never mutates or re-registers tool definitions. */
export function installToolExecutionAdapter(
  host: object,
  resolver: ToolRowResolver,
): ToolExecutionAdapterInstallation {
  const prototype = host as HostPrototype;
  const existing = ownState(prototype);
  if (
    existing &&
    ownMethod(prototype, "getCallRenderer") === existing.patchedCall &&
    ownMethod(prototype, "getResultRenderer") === existing.patchedResult &&
    ownMethod(prototype, "getRenderShell") === existing.patchedShell
  ) {
    const owner = {};
    existing.resolver = resolver;
    existing.owner = owner;
    existing.active = true;
    sweepRows(existing);
    invalidateRows(existing);
    return { dispose: () => dispose(prototype, existing, owner) };
  }
  if (existing) {
    throw new Error("mpi-tool-display found a stale ToolExecutionComponent adapter state");
  }

  const callDescriptor = assertMethodDescriptor(prototype, "getCallRenderer");
  const resultDescriptor = assertMethodDescriptor(prototype, "getResultRenderer");
  const shellDescriptor = assertMethodDescriptor(prototype, "getRenderShell");
  const originalCall = callDescriptor.value as RendererSelector<CallRenderer>;
  const originalResult = resultDescriptor.value as RendererSelector<ResultRenderer>;
  const originalShell = shellDescriptor.value as ShellSelector;
  const owner = {};
  const state = {
    callDescriptor,
    resultDescriptor,
    shellDescriptor,
    resolver,
    rows: new Set<WeakRef<ToolRowHost>>(),
    addedSinceSweep: 0,
    owner,
    active: true,
  } as InstallationState;

  const patchedCall: RendererSelector<CallRenderer> = function (...args) {
    const native = originalCall.apply(this, args);
    if (!state.active) return native;
    trackRow(state, this);
    return state.resolver.call(toolName(this), native);
  };
  const patchedResult: RendererSelector<ResultRenderer> = function (...args) {
    const native = originalResult.apply(this, args);
    if (!state.active) return native;
    trackRow(state, this);
    return state.resolver.result(toolName(this), native);
  };
  const patchedShell: ShellSelector = function (...args) {
    const native = originalShell.apply(this, args);
    if (!state.active) return native;
    trackRow(state, this);
    return state.resolver.shell(toolName(this), native);
  };
  state.patchedCall = patchedCall;
  state.patchedResult = patchedResult;
  state.patchedShell = patchedShell;

  try {
    Object.defineProperty(prototype, STATE, { value: state, configurable: true });
    Object.defineProperty(prototype, "getCallRenderer", {
      ...callDescriptor,
      value: patchedCall,
    });
    Object.defineProperty(prototype, "getResultRenderer", {
      ...resultDescriptor,
      value: patchedResult,
    });
    Object.defineProperty(prototype, "getRenderShell", {
      ...shellDescriptor,
      value: patchedShell,
    });
  } catch (error) {
    restore(prototype, state);
    throw error;
  }

  invalidateRows(state);
  return { dispose: () => dispose(prototype, state, owner) };
}
