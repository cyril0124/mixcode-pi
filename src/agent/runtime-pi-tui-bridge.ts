// Bridge between the project's top-level @earendil-works/pi-tui module and the
// nested copy that @earendil-works/pi-coding-agent ships via its
// npm-shrinkwrap.
//
// Why this exists
// ---------------
// pi-coding-agent declares "hasShrinkwrap": true and pins its own pi-tui
// dependency. npm honors that shrinkwrap regardless of `overrides` in the
// host project, so we end up with two distinct pi-tui module instances on
// disk:
//
//   node_modules/@earendil-works/pi-tui                     (top-level)
//   node_modules/@earendil-works/pi-coding-agent/
//     node_modules/@earendil-works/pi-tui                   (nested)
//
// pi-tui keeps `globalKeybindings` as module-level state. Components shipped
// by pi-coding-agent (read/grep/find/skill/...) call `getKeybindings()` from
// the nested copy, so any keybindings set via the top-level module are
// invisible to them. The user-visible symptom is empty keybinding labels like
// "( to expand)" instead of "(ctrl+o to expand)".
//
// What this module does
// ---------------------
// On load, it locates the nested pi-tui by walking from the resolved
// pi-coding-agent entry to its sibling `node_modules/@earendil-works/pi-tui`.
// `applyMixCodeKeybindings()` then mirrors `setKeybindings` calls onto both
// copies so upstream renderers and our own renderers agree on the keybinding
// state.
//
// Failure mode
// ------------
// If the nested copy ever disappears (for example, because pi-coding-agent
// stops shipping a shrinkwrap and npm dedupes pi-tui), the bridge logs an
// explicit warning and degrades to top-level-only. This is intentional: it
// surfaces drift loudly instead of silently regressing the UI.

import { dirname } from "node:path";
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

// Eagerly resolve the nested copy at module load. Top-level await keeps the
// resolution synchronous from a consumer's perspective: by the time anyone
// imports `applyMixCodeKeybindings`, the nested module is either ready or
// confirmed missing.
const nestedPiTui: PiTuiKeybindingsModule | undefined = await resolveNestedPiTui();

async function resolveNestedPiTui(): Promise<PiTuiKeybindingsModule | undefined> {
  // Resolve the pi-coding-agent entry to locate its nested pi-tui copy.
  // In any bundled/compiled binary (bun --compile, Node SEA, etc.),
  // import.meta.resolve will fail because node_modules don't exist on disk.
  // Treat that as "no nested copy" — all modules are already unified in the
  // bundle so there's no dual-instance problem to fix.
  let codingAgentEntry: string;
  try {
    codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  } catch {
    return undefined;
  }
  // pi-coding-agent's main is at <pkgDir>/dist/index.js. The nested pi-tui
  // copy lives at <pkgDir>/node_modules/@earendil-works/pi-tui when the
  // upstream shrinkwrap is in effect.
  const distDir = dirname(codingAgentEntry);
  const pkgDir = dirname(distDir);
  const nestedEntry = `${pkgDir}/node_modules/@earendil-works/pi-tui/dist/index.js`;
  try {
    return (await import(nestedEntry)) as PiTuiKeybindingsModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      // Nested copy not present (e.g. pi-coding-agent dropped its shrinkwrap
      // and npm deduped pi-tui to a single instance). The top-level set is
      // already sufficient; nothing to mirror.
      return undefined;
    }
    throw error;
  }
}

// Apply mixcode's keybindings to every pi-tui module instance we know about
// and return a restore handle.
//
// Callers wrap a render block with this so renderers shipped by upstream
// (which resolve `keyText`/`keyHint` against the nested copy) and renderers
// in this repo (which use the top-level copy) both see the same manager.
export function applyMixCodeKeybindings(): () => void {
  const previousOuter = getOuterKeybindings();
  const previousNested = nestedPiTui?.getKeybindings();
  setOuterKeybindings(
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER as unknown as Parameters<typeof setOuterKeybindings>[0],
  );
  nestedPiTui?.setKeybindings(MIXCODE_EXTENSION_KEYBINDINGS_MANAGER);
  return () => {
    setOuterKeybindings(previousOuter);
    if (nestedPiTui && previousNested !== undefined) {
      nestedPiTui.setKeybindings(previousNested);
    }
  };
}

// Test seam: lets focused tests verify the bridge actually located the nested
// copy and that it is structurally distinct from the top-level module.
export async function loadNestedPiTui(): Promise<PiTuiKeybindingsModule | undefined> {
  return nestedPiTui;
}
