// Render-only ToolExecutionComponent adapter; license notices: ./THIRD_PARTY_NOTICES.md.
// This package keeps only guarded render-path selection.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
export type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
export type RenderShell = NonNullable<ToolDefinition["renderShell"]>;

interface ToolRowHost {
  toolName?: string;
  args?: unknown;
  invalidate?: () => void;
  toolDefinition?: { name?: string };
  builtInToolDefinition?: { name?: string };
}

type RendererSelector<T> = (this: ToolRowHost, ...args: unknown[]) => T | undefined;
type GenericFormatter = (this: ToolRowHost, ...args: unknown[]) => string;
type ShellSelector = (this: ToolRowHost, ...args: unknown[]) => RenderShell;

export interface ToolRowResolver {
  call(toolName: string, native: CallRenderer | undefined): CallRenderer | undefined;
  result(toolName: string, native: ResultRenderer | undefined): ResultRenderer | undefined;
  shell(toolName: string, native: RenderShell): RenderShell;
  showRawArguments(toolName: string): boolean;
}

interface InstallationState {
  formatDescriptor: PropertyDescriptor;
  callDescriptor: PropertyDescriptor;
  resultDescriptor: PropertyDescriptor;
  shellDescriptor: PropertyDescriptor;
  patchedFormat: GenericFormatter;
  patchedCall: RendererSelector<CallRenderer>;
  patchedResult: RendererSelector<ResultRenderer>;
  patchedShell: ShellSelector;
  resolver: ToolRowResolver;
  rows: Set<WeakRef<ToolRowHost>>;
  /** Live-row dedupe: one WeakRef per row, and a reentry guard for trackRow. */
  trackedRows: WeakSet<ToolRowHost>;
  addedSinceSweep: number;
  owner: object;
  active: boolean;
}

const STATE = Symbol.for("mpi-tool-display.toolExecutionAdapter.v3");
type HostPrototype = ToolRowHost & {
  formatToolExecution?: GenericFormatter;
  getCallRenderer?: RendererSelector<CallRenderer>;
  getResultRenderer?: RendererSelector<ResultRenderer>;
  getRenderShell?: ShellSelector;
  [STATE]?: InstallationState;
};

export interface ToolExecutionAdapterInstallation {
  dispose(): void;
}

function installationHandle(
  prototype: HostPrototype,
  state: InstallationState,
  owner: object,
): ToolExecutionAdapterInstallation {
  return {
    dispose: () => dispose(prototype, state, owner),
  };
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
  // ToolExecutionComponent.invalidate() synchronously runs updateDisplay(),
  // which re-invokes the patched getters and re-enters trackRow. Deduping via
  // WeakSet keeps rows finite (one ref per row) and breaks the feedback that
  // would otherwise grow the Set while invalidateRows iterates it.
  if (state.trackedRows.has(row)) return;
  state.trackedRows.add(row);
  state.rows.add(new WeakRef(row));
  if (state.addedSinceSweep++ > state.rows.size) sweepRows(state);
}

function invalidateRows(state: InstallationState): void {
  // Snapshot before iterating: invalidate() re-enters the patched getters,
  // and Set iteration would visit entries appended mid-walk.
  for (const ref of [...state.rows]) {
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
  key: "formatToolExecution" | "getCallRenderer" | "getResultRenderer" | "getRenderShell",
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
  if (ownMethod(prototype, "formatToolExecution") === state.patchedFormat) {
    Object.defineProperty(prototype, "formatToolExecution", state.formatDescriptor);
  }
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
    ownMethod(prototype, "formatToolExecution") !== state.patchedFormat &&
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
    ownMethod(prototype, "formatToolExecution") === existing.patchedFormat &&
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
    return installationHandle(prototype, existing, owner);
  }
  if (existing) {
    throw new Error("mpi-tool-display found a stale ToolExecutionComponent adapter state");
  }

  const formatDescriptor = assertMethodDescriptor(prototype, "formatToolExecution");
  const callDescriptor = assertMethodDescriptor(prototype, "getCallRenderer");
  const resultDescriptor = assertMethodDescriptor(prototype, "getResultRenderer");
  const shellDescriptor = assertMethodDescriptor(prototype, "getRenderShell");
  const originalFormat = formatDescriptor.value as GenericFormatter;
  const originalCall = callDescriptor.value as RendererSelector<CallRenderer>;
  const originalResult = resultDescriptor.value as RendererSelector<ResultRenderer>;
  const originalShell = shellDescriptor.value as ShellSelector;
  const owner = {};
  const state = {
    formatDescriptor,
    callDescriptor,
    resultDescriptor,
    shellDescriptor,
    resolver,
    rows: new Set<WeakRef<ToolRowHost>>(),
    trackedRows: new WeakSet<ToolRowHost>(),
    addedSinceSweep: 0,
    owner,
    active: true,
  } as InstallationState;

  const patchedFormat: GenericFormatter = function (...args) {
    trackRow(state, this);
    if (!state.active || state.resolver.showRawArguments(toolName(this))) {
      return originalFormat.apply(this, args);
    }
    const originalArgs = this.args;
    // Pi's generic formatter synchronously owns title/result/image text. Hide
    // only its argument input so every other native byte remains unchanged.
    this.args = undefined;
    try {
      return originalFormat.apply(this, args);
    } finally {
      this.args = originalArgs;
    }
  };
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
  state.patchedFormat = patchedFormat;
  state.patchedCall = patchedCall;
  state.patchedResult = patchedResult;
  state.patchedShell = patchedShell;

  try {
    Object.defineProperty(prototype, STATE, { value: state, configurable: true });
    Object.defineProperty(prototype, "formatToolExecution", {
      ...formatDescriptor,
      value: patchedFormat,
    });
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
  return installationHandle(prototype, state, owner);
}
