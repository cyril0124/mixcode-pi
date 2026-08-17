// Bridge for mixcode keybindings across pi-tui module instance(s).
//
// Why this exists
// ---------------
// pi-tui keeps `globalKeybindings` as module-level state. When the install
// tree has *two* physical pi-tui copies, each copy has its own state:
//
//   node_modules/@earendil-works/pi-tui                     (top-level)
//   node_modules/@earendil-works/pi-coding-agent/
//     node_modules/@earendil-works/pi-tui                   (nested, optional)
//
// That nested copy can appear under npm when pi-coding-agent's shrinkwrap is
// honored. Bun (and some npm trees) often dedupe to a single top-level copy.
// With two instances, setting keybindings only on the top-level leaves upstream
// renderers (which import the nested copy) showing blank hints like
// "( to expand)" instead of "(ctrl+o to expand)".
//
// What this module does
// ---------------------
// `applyMixCodeKeybindings()` always sets the top-level manager. If a *distinct*
// nested instance is discoverable (or injected for bun --compile), the same
// manager is mirrored there. If there is only one instance, top-level-only is
// correct for both Node and Bun — no postinstall layout hacks required.

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getKeybindings as getOuterKeybindings,
  setKeybindings as setOuterKeybindings,
} from "@earendil-works/pi-tui";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "./runtime-extension-theme.js";

// The shape we depend on from a pi-tui module instance.
export interface PiTuiKeybindingsModule {
  setKeybindings: (manager: unknown) => void;
  getKeybindings: () => unknown;
}

// Injection point for compiled binaries where runtime module resolution fails.
// binary-entry.ts statically imports the nested pi-tui keybindings module and
// stashes it on globalThis under a well-known symbol before the bridge loads.
const NESTED_PI_TUI_SYMBOL = Symbol.for("mixcode-pi.nested-pi-tui");
const injectedNestedPiTui: PiTuiKeybindingsModule | undefined = (() => {
  const candidate = (globalThis as Record<symbol, unknown>)[NESTED_PI_TUI_SYMBOL] as
    | PiTuiKeybindingsModule
    | undefined;
  if (!candidate || typeof candidate.setKeybindings !== "function") return undefined;
  // Only accept if it's genuinely a different module instance.
  if (candidate.setKeybindings === (setOuterKeybindings as unknown)) return undefined;
  return candidate;
})();

// Resolve the nested copy lazily: kick off the async lookup at module load
// without blocking module evaluation. Top-level await would guarantee the
// copy is ready before any caller under Node (which pauses importers), but Bun
// evaluates importers of this module while the await is still pending, so
// accessing the eagerly-resolved constant from applyMixCodeKeybindings throws
// a TDZ ReferenceError there. The lookup is a local file import that settles
// in milliseconds; callers that run before it resolves simply skip mirroring
// the nested copy (correct under Bun's single-instance dedupe, and Node's
// evaluation order still surfaces the nested copy on subsequent calls).
let nestedPiTui: PiTuiKeybindingsModule | undefined = injectedNestedPiTui;
const nestedResolve: Promise<PiTuiKeybindingsModule | undefined> =
  injectedNestedPiTui !== undefined
    ? Promise.resolve(injectedNestedPiTui)
    : resolveNestedPiTui();
void nestedResolve.then((mod) => {
  if (mod !== undefined) nestedPiTui = mod;
});

async function resolveNestedPiTui(): Promise<PiTuiKeybindingsModule | undefined> {
  // Resolve the pi-coding-agent entry to locate its nested pi-tui copy.
  // In any bundled/compiled binary (bun --compile, Node SEA, etc.),
  // import.meta.resolve will fail because node_modules don't exist on disk.
  let codingAgentEntry: string;
  try {
    codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  } catch {
    // Bun compiled binary: try CJS require via the nested path.
    // Bun bundles both pi-tui copies; createRequire can reach the nested one
    // even though the filesystem path is virtual.
    return resolveNestedViaCjs();
  }
  // pi-coding-agent's main is at <pkgDir>/dist/index.js. The nested pi-tui
  // copy lives at <pkgDir>/node_modules/@earendil-works/pi-tui when the
  // upstream shrinkwrap is in effect.
  const distDir = path.dirname(codingAgentEntry);
  const pkgDir = path.dirname(distDir);
  // Import the same ESM entry that pi-coding-agent components resolve.
  const nestedEntry = `${pkgDir}/node_modules/@earendil-works/pi-tui/dist/index.js`;
  try {
    return (await import(nestedEntry)) as PiTuiKeybindingsModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  // CJS is only a fallback: require() can create separate module state from the ESM entry.
  const nestedKeybindingsPath = `${pkgDir}/node_modules/@earendil-works/pi-tui/dist/keybindings.js`;
  return loadNestedKeybindingsViaCjs(nestedKeybindingsPath);
}

// Use createRequire to load the nested keybindings module directly by
// absolute path. This bypasses package.json "exports" restrictions that
// block subpath imports in Node 22+.
function loadNestedKeybindingsViaCjs(absolutePath: string): PiTuiKeybindingsModule | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require(absolutePath) as PiTuiKeybindingsModule;
    if (mod.setKeybindings === (setOuterKeybindings as unknown)) return undefined;
    return mod;
  } catch {
    return undefined;
  }
}

// Fallback for Bun compiled binary where import.meta.resolve fails.
// Bun's virtual FS still serves bundled node_modules via createRequire.
function resolveNestedViaCjs(): PiTuiKeybindingsModule | undefined {
  try {
    const require = createRequire(import.meta.url);
    // Walk from the resolved pi-coding-agent dist entry to find the nested pi-tui.
    const codingAgentMain = require.resolve("@earendil-works/pi-coding-agent");
    const pkgDir = path.dirname(path.dirname(codingAgentMain));
    const nestedPath = `${pkgDir}/node_modules/@earendil-works/pi-tui/dist/keybindings.js`;
    const mod = require(nestedPath) as PiTuiKeybindingsModule;
    if (mod.setKeybindings === (setOuterKeybindings as unknown)) return undefined;
    return mod;
  } catch {
    return undefined;
  }
}

// Resolve the effective nested module: prefer injected (for compiled binary)
// over the eagerly-resolved one (for dev/node).
function getNestedPiTui(): PiTuiKeybindingsModule | undefined {
  // Re-read from globalThis each time — binary-entry writes the compiled nested copy here.
  const fromGlobal = (globalThis as Record<symbol, unknown>)[NESTED_PI_TUI_SYMBOL] as
    | PiTuiKeybindingsModule
    | undefined;
  if (
    fromGlobal &&
    typeof fromGlobal.setKeybindings === "function" &&
    fromGlobal.setKeybindings !== (setOuterKeybindings as unknown)
  ) {
    return fromGlobal;
  }
  return nestedPiTui;
}

// Apply mixcode's keybindings to every pi-tui module instance we know about
// and return a restore handle.
//
// Callers wrap a render block with this so renderers shipped by upstream
// (which resolve `keyText`/`keyHint` against the nested copy) and renderers
// in this repo (which use the top-level copy) both see the same manager.
export function applyMixCodeKeybindings(): () => void {
  const nested = getNestedPiTui();
  const previousOuter = getOuterKeybindings();
  const previousNested = nested?.getKeybindings();
  setOuterKeybindings(
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER as unknown as Parameters<typeof setOuterKeybindings>[0],
  );
  nested?.setKeybindings(MIXCODE_EXTENSION_KEYBINDINGS_MANAGER);
  return () => {
    setOuterKeybindings(previousOuter);
    if (nested && previousNested !== undefined) {
      nested.setKeybindings(previousNested);
    }
  };
}

// Test seam: lets focused tests verify the bridge actually located the nested
// copy and that it is structurally distinct from the top-level module.
export async function loadNestedPiTui(): Promise<PiTuiKeybindingsModule | undefined> {
  return getNestedPiTui();
}
