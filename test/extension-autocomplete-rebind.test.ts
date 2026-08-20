import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { createSkillCompletionWrapper } from "../pi-packages/mpi-skill-refs/skill-core.js";
import { applyExtensionAutocompleteProviders } from "../src/agent/runtime-extension-ui.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "../src/ui/app-editor.js";
import { createActiveAutocompleteProvider } from "../src/ui/app-runtime.js";
import { MixCodeCompletionProvider } from "../src/ui/components/completion.js";
import { themeForId } from "../src/ui/themes.js";

/**
 * Production-shaped path (matches app.ts + Pi InteractiveMode):
 * 1. Live activeCompletionProvider (real MixCode base with fd/@).
 * 2. Custom setEditorComponent skin.
 * 3. Extension addAutocompleteProvider (skill-refs style) rebinds via
 *    EditorSlot.setAutocompleteProvider(liveProxy) — never a passthrough base.
 */
async function waitFor(predicate: () => boolean, attempts = 250): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  assert.equal(predicate(), true);
}

test("custom editor skin keeps @ file completion after extension $ wrapper rebind", async () => {
  const fdPath = Bun.which("fd") ?? undefined;
  assert.ok(fdPath, "fd required for @ fuzzy file completion (Pi CombinedAutocompleteProvider)");

  const state = createInitialState(process.cwd());
  const tab = createTab(1, "s1", process.cwd());
  state.tabs.push(tab);
  state.activeTabId = "s1";

  const tui = {
    requestRender: () => undefined,
    setFocus: () => undefined,
    terminal: { rows: 40, columns: 80 },
  };
  const defaultEditor = new CompactPromptEditor(
    tui as never,
    editorThemeFor(themeForId(state.theme)),
    { paddingX: 1 },
    state,
  );
  const slot = new EditorSlot(tui as never, defaultEditor, state);

  const base = new MixCodeCompletionProvider({
    skills: [],
    workdir: () => process.cwd(),
    fdPath,
  });

  const runtimeTab = {
    extensionAutocompleteProviderFactories: [] as Array<
      (provider: AutocompleteProvider) => AutocompleteProvider
    >,
    extensionAutocompleteProviderCache: undefined as
      | { base: AutocompleteProvider; factoryCount: number; provider: AutocompleteProvider }
      | undefined,
  };

  const runtime = {
    getTab: (id: string) => (id === "s1" ? runtimeTab : undefined),
    applyExtensionAutocompleteProviders: (_sessionId: string, b: AutocompleteProvider) =>
      applyExtensionAutocompleteProviders(runtimeTab as never, b),
  };

  const live = createActiveAutocompleteProvider(state, runtime as never, base);
  // Initial bind (TUI boot) — no extension wrappers yet.
  slot.setAutocompleteProvider(live);

  // Custom skin (open-tui style) before/around extension autocomplete register.
  const kb = { matches: () => false };
  slot.setEditorComponent(
    (t, th, k) => new CustomEditor(t, th, (k ?? kb) as never, { paddingX: 0 }),
  );

  // skill-refs style wrapper registration + rebind (production: addAutocompleteProvider).
  runtimeTab.extensionAutocompleteProviderFactories.push((current) =>
    createSkillCompletionWrapper(current, () => [
      { name: "demo", filePath: "/x", baseDir: "/x", description: "d" },
    ]),
  );
  runtimeTab.extensionAutocompleteProviderCache = undefined;
  // Cold rebind: live proxy only — never a passthrough-rooted chain.
  slot.setAutocompleteProvider(live);

  const editor = slot.current;
  editor.setText("");
  editor.handleInput("@");
  // fd-backed fuzzy completion is async (subprocess + debounce); poll instead
  // of racing a fixed sleep so loaded (parallel/CI) runs cannot flake.
  await waitFor(() => editor.isShowingAutocomplete?.() === true);
  assert.equal(editor.isShowingAutocomplete?.(), true, "@ must open file completion on custom skin");

  editor.setText("");
  editor.handleInput("$");
  await waitFor(() => editor.isShowingAutocomplete?.() === true);
  assert.equal(editor.isShowingAutocomplete?.(), true, "$ must open skill completion on custom skin");
});

test("passthrough-rooted autocomplete chain breaks @ (regression guard)", async () => {
  // Documents the bug we fixed: wrapping skill-refs around a dummy base that
  // returns null for non-$ tokens kills @ file completion.
  const passthrough: AutocompleteProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };
  const broken = createSkillCompletionWrapper(passthrough, () => []);
  const at = await broken.getSuggestions(["@"], 0, 1, {
    signal: AbortSignal.timeout(2000),
    force: true,
  });
  assert.equal(at, null, "passthrough base yields null for @");
});
