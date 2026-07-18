// Standalone binary entry point.
// Must set PI_PACKAGE_DIR BEFORE any other module initializes, because
// pi-coding-agent's config module reads package.json and built-in resources
// eagerly at import/render time.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import darkTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json" with { type: "json" };
import lightTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json" with { type: "json" };
import exportTemplateCss from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.css" with { type: "text" };
import exportTemplateHtml from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html" with { type: "text" };
import exportTemplateJs from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js" with { type: "text" };
import exportVendorMarked from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/marked.min.js" with { type: "text" };
import exportVendorHighlight from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/highlight.min.js" with { type: "text" };
import clankolasImagePath from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets/clankolas.png" with { type: "file" };
import photonWasmPath from "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" };
import searchGuardIndex from "../../pi-packages/mpi-search-guard/index.ts" with { type: "text" };
import searchGuardPackageJson from "../../pi-packages/mpi-search-guard/package.json" with { type: "text" };
import imageHoistIndex from "../../pi-packages/mpi-image-hoist/index.ts" with { type: "text" };
import imageHoistPackageJson from "../../pi-packages/mpi-image-hoist/package.json" with { type: "text" };
import diffTrackerIndex from "../../pi-packages/mpi-diff-tracker/index.ts" with { type: "text" };
import diffTrackerPackageJson from "../../pi-packages/mpi-diff-tracker/package.json" with { type: "text" };
import commandBrowserIndex from "../../pi-packages/mpi-command-browser/index.ts" with { type: "text" };
import commandBrowserComponent from "../../pi-packages/mpi-command-browser/command-browser.ts" with { type: "text" };
import commandBrowserPackageJson from "../../pi-packages/mpi-command-browser/package.json" with { type: "text" };
import chatViewIndex from "../../pi-packages/mpi-chat-view/index.ts" with { type: "text" };
import chatViewPackageJson from "../../pi-packages/mpi-chat-view/package.json" with { type: "text" };
import bashDefaultTimeoutIndex from "../../pi-packages/mpi-bash-default-timeout/index.ts" with { type: "text" };
import bashDefaultTimeoutPackageJson from "../../pi-packages/mpi-bash-default-timeout/package.json" with { type: "text" };
import loopIndex from "../../pi-packages/mpi-loop/index.ts" with { type: "text" };
import loopHelpers from "../../pi-packages/mpi-loop/loop-helpers.ts" with { type: "text" };
import loopManagementView from "../../pi-packages/mpi-loop/loop-management-view.ts" with { type: "text" };
import loopPackageJson from "../../pi-packages/mpi-loop/package.json" with { type: "text" };
import rpivTodo_config_ts from "../../pi-packages/rpiv-todo/config.ts" with { type: "text" };
import rpivTodo_index_ts from "../../pi-packages/rpiv-todo/index.ts" with { type: "text" };
import rpivTodo_locales_de_json from "../../pi-packages/rpiv-todo/locales/de.json" with { type: "text" };
import rpivTodo_locales_en_json from "../../pi-packages/rpiv-todo/locales/en.json" with { type: "text" };
import rpivTodo_locales_es_json from "../../pi-packages/rpiv-todo/locales/es.json" with { type: "text" };
import rpivTodo_locales_fr_json from "../../pi-packages/rpiv-todo/locales/fr.json" with { type: "text" };
import rpivTodo_locales_pt_BR_json from "../../pi-packages/rpiv-todo/locales/pt-BR.json" with { type: "text" };
import rpivTodo_locales_pt_json from "../../pi-packages/rpiv-todo/locales/pt.json" with { type: "text" };
import rpivTodo_locales_ru_json from "../../pi-packages/rpiv-todo/locales/ru.json" with { type: "text" };
import rpivTodo_locales_uk_json from "../../pi-packages/rpiv-todo/locales/uk.json" with { type: "text" };
import rpivTodo_locales_zh_json from "../../pi-packages/rpiv-todo/locales/zh.json" with { type: "text" };
import rpivTodo_package_json from "../../pi-packages/rpiv-todo/package.json" with { type: "text" };
import rpivTodo_state_i18n_bridge_ts from "../../pi-packages/rpiv-todo/state/i18n-bridge.ts" with { type: "text" };
import rpivTodo_state_invariants_ts from "../../pi-packages/rpiv-todo/state/invariants.ts" with { type: "text" };
import rpivTodo_state_replay_ts from "../../pi-packages/rpiv-todo/state/replay.ts" with { type: "text" };
import rpivTodo_state_selectors_ts from "../../pi-packages/rpiv-todo/state/selectors.ts" with { type: "text" };
import rpivTodo_state_session_ts from "../../pi-packages/rpiv-todo/state/session.ts" with { type: "text" };
import rpivTodo_state_state_reducer_ts from "../../pi-packages/rpiv-todo/state/state-reducer.ts" with { type: "text" };
import rpivTodo_state_state_ts from "../../pi-packages/rpiv-todo/state/state.ts" with { type: "text" };
import rpivTodo_state_store_ts from "../../pi-packages/rpiv-todo/state/store.ts" with { type: "text" };
import rpivTodo_state_task_graph_ts from "../../pi-packages/rpiv-todo/state/task-graph.ts" with { type: "text" };
import rpivTodo_todo_overlay_ts from "../../pi-packages/rpiv-todo/todo-overlay.ts" with { type: "text" };
import rpivTodo_todo_ts from "../../pi-packages/rpiv-todo/todo.ts" with { type: "text" };
import rpivTodo_tool_response_envelope_ts from "../../pi-packages/rpiv-todo/tool/response-envelope.ts" with { type: "text" };
import rpivTodo_tool_types_ts from "../../pi-packages/rpiv-todo/tool/types.ts" with { type: "text" };
import rpivTodo_vendor_rpiv_config_ts from "../../pi-packages/rpiv-todo/vendor/rpiv-config.ts" with { type: "text" };
import rpivTodo_view_format_ts from "../../pi-packages/rpiv-todo/view/format.ts" with { type: "text" };
import skillRefsIndex from "../../pi-packages/mpi-skill-refs/index.ts" with { type: "text" };
import skillRefsCore from "../../pi-packages/mpi-skill-refs/skill-core.ts" with { type: "text" };
import skillRefsPackageJson from "../../pi-packages/mpi-skill-refs/package.json" with { type: "text" };
import mpiGoal_index_ts from "../../pi-packages/mpi-goal/index.ts" with { type: "text" };
import mpiGoal_package_json from "../../pi-packages/mpi-goal/package.json" with { type: "text" };
import mpiGoal_src_app_ts from "../../pi-packages/mpi-goal/src/app.ts" with { type: "text" };
import mpiGoal_src_domain_active_time_ts from "../../pi-packages/mpi-goal/src/domain/active-time.ts" with { type: "text" };
import mpiGoal_src_domain_session_scope_ts from "../../pi-packages/mpi-goal/src/domain/session-scope.ts" with { type: "text" };
import mpiGoal_src_domain_budget_ts from "../../pi-packages/mpi-goal/src/domain/budget.ts" with { type: "text" };
import mpiGoal_src_domain_completion_gate_ts from "../../pi-packages/mpi-goal/src/domain/completion-gate.ts" with { type: "text" };
import mpiGoal_src_domain_constants_ts from "../../pi-packages/mpi-goal/src/domain/constants.ts" with { type: "text" };
import mpiGoal_src_domain_feature_flags_ts from "../../pi-packages/mpi-goal/src/domain/feature-flags.ts" with { type: "text" };
import mpiGoal_src_domain_floor_steering_ts from "../../pi-packages/mpi-goal/src/domain/floor-steering.ts" with { type: "text" };
import mpiGoal_src_domain_floor_ts from "../../pi-packages/mpi-goal/src/domain/floor.ts" with { type: "text" };
import mpiGoal_src_domain_format_ts from "../../pi-packages/mpi-goal/src/domain/format.ts" with { type: "text" };
import mpiGoal_src_domain_goal_intent_ts from "../../pi-packages/mpi-goal/src/domain/goal-intent.ts" with { type: "text" };
import mpiGoal_src_domain_telemetry_ts from "../../pi-packages/mpi-goal/src/domain/telemetry.ts" with { type: "text" };
import mpiGoal_src_domain_types_ts from "../../pi-packages/mpi-goal/src/domain/types.ts" with { type: "text" };
import mpiGoal_src_persistence_goal_store_ts from "../../pi-packages/mpi-goal/src/persistence/goal-store.ts" with { type: "text" };
import mpiGoal_src_persistence_queue_store_ts from "../../pi-packages/mpi-goal/src/persistence/queue-store.ts" with { type: "text" };
import mpiGoal_src_queue_block_parser_ts from "../../pi-packages/mpi-goal/src/queue/block-parser.ts" with { type: "text" };
import mpiGoal_src_queue_steering_ts from "../../pi-packages/mpi-goal/src/queue/steering.ts" with { type: "text" };
import mpiGoal_src_runtime_context_reset_ts from "../../pi-packages/mpi-goal/src/runtime/context-reset.ts" with { type: "text" };
import mpiGoal_src_runtime_continuation_ticket_ts from "../../pi-packages/mpi-goal/src/runtime/continuation-ticket.ts" with { type: "text" };
import mpiGoal_src_runtime_continuation_ts from "../../pi-packages/mpi-goal/src/runtime/continuation.ts" with { type: "text" };
import mpiGoal_src_runtime_lifecycle_ts from "../../pi-packages/mpi-goal/src/runtime/lifecycle.ts" with { type: "text" };
import mpiGoal_src_runtime_post_completion_ts from "../../pi-packages/mpi-goal/src/runtime/post-completion.ts" with { type: "text" };
import mpiGoal_src_runtime_prompts_ts from "../../pi-packages/mpi-goal/src/runtime/prompts.ts" with { type: "text" };
import mpiGoal_src_runtime_terminal_workflow_ts from "../../pi-packages/mpi-goal/src/runtime/terminal-workflow.ts" with { type: "text" };
import mpiGoal_src_surface_command_register_ts from "../../pi-packages/mpi-goal/src/surface/command/register.ts" with { type: "text" };
import mpiGoal_src_surface_tools_dynamic_ts from "../../pi-packages/mpi-goal/src/surface/tools/dynamic.ts" with { type: "text" };
import mpiGoal_src_surface_tools_goal_tools_ts from "../../pi-packages/mpi-goal/src/surface/tools/goal-tools.ts" with { type: "text" };
import mpiGoal_src_surface_tools_names_ts from "../../pi-packages/mpi-goal/src/surface/tools/names.ts" with { type: "text" };
import mpiGoal_src_surface_tools_queue_tools_ts from "../../pi-packages/mpi-goal/src/surface/tools/queue-tools.ts" with { type: "text" };
import mpiGoal_src_surface_tools_results_ts from "../../pi-packages/mpi-goal/src/surface/tools/results.ts" with { type: "text" };
import mpiGoal_src_surface_tools_schemas_ts from "../../pi-packages/mpi-goal/src/surface/tools/schemas.ts" with { type: "text" };
import mpiGoal_src_surface_ui_goal_overlay_ts from "../../pi-packages/mpi-goal/src/surface/ui/goal-overlay.ts" with { type: "text" };
import mpiGoal_src_surface_ui_notify_ts from "../../pi-packages/mpi-goal/src/surface/ui/notify.ts" with { type: "text" };
import mpiGoal_src_surface_ui_widget_ts from "../../pi-packages/mpi-goal/src/surface/ui/widget.ts" with { type: "text" };
import mpiGoal_src_templates_discover_ts from "../../pi-packages/mpi-goal/src/templates/discover.ts" with { type: "text" };
import promptHistoryIndex from "../../pi-packages/mpi-prompt-history/index.ts" with { type: "text" };
import promptHistoryBrowser from "../../pi-packages/mpi-prompt-history/prompt-history-browser.ts" with { type: "text" };
import promptHistoryPackageJson from "../../pi-packages/mpi-prompt-history/package.json" with { type: "text" };
import autoRenameIndex from "../../pi-packages/mpi-auto-rename/index.ts" with { type: "text" };
import autoRenamePackageJson from "../../pi-packages/mpi-auto-rename/package.json" with { type: "text" };
import packageJson from "../../package.json" with { type: "json" };
import { materializeBinaryRuntimeAssets } from "./binary-assets.js";

// Static import of the nested pi-tui keybindings module that pi-coding-agent
// ships via its shrinkwrap. In a compiled binary, runtime module resolution
// (import.meta.resolve / createRequire) cannot locate this nested copy, so we
// import it statically and stash it on globalThis for the bridge to pick up.
// We cannot import the bridge directly here because it transitively pulls in
// pi-coding-agent which reads PI_PACKAGE_DIR eagerly (not yet set at this point).
import * as nestedPiTuiKeybindings from "../../node_modules/@earendil-works/pi-tui/dist/keybindings.js";

// Use mkdtempSync for unpredictable temp dir name (avoids symlink attacks on shared systems)
const runtimeDir = mkdtempSync(join(tmpdir(), "mixcode-pi-"));

function cleanup() {
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

materializeBinaryRuntimeAssets(runtimeDir, {
  darkTheme,
  lightTheme,
  exportTemplateCss,
  exportTemplateHtml,
  exportTemplateJs,
  exportVendorMarked,
  exportVendorHighlight,
  interactiveAssets: { "clankolas.png": clankolasImagePath },
  photonWasmPath,
  packageJson,
  builtinPackages: {
    "mpi-search-guard": {
      "index.ts": searchGuardIndex,
      "package.json": searchGuardPackageJson,
    },
    "mpi-image-hoist": {
      "index.ts": imageHoistIndex,
      "package.json": imageHoistPackageJson,
    },
    "mpi-diff-tracker": {
      "index.ts": diffTrackerIndex,
      "package.json": diffTrackerPackageJson,
    },
    "mpi-command-browser": {
      "index.ts": commandBrowserIndex,
      "command-browser.ts": commandBrowserComponent,
      "package.json": commandBrowserPackageJson,
    },
    "mpi-chat-view": {
      "index.ts": chatViewIndex,
      "package.json": chatViewPackageJson,
    },
    "mpi-bash-default-timeout": {
      "index.ts": bashDefaultTimeoutIndex,
      "package.json": bashDefaultTimeoutPackageJson,
    },
    "mpi-loop": {
      "index.ts": loopIndex,
      "loop-helpers.ts": loopHelpers,
      "loop-management-view.ts": loopManagementView,
      "package.json": loopPackageJson,
    },
    "rpiv-todo": {
      "config.ts": rpivTodo_config_ts,
      "index.ts": rpivTodo_index_ts,
      "locales/de.json": rpivTodo_locales_de_json,
      "locales/en.json": rpivTodo_locales_en_json,
      "locales/es.json": rpivTodo_locales_es_json,
      "locales/fr.json": rpivTodo_locales_fr_json,
      "locales/pt-BR.json": rpivTodo_locales_pt_BR_json,
      "locales/pt.json": rpivTodo_locales_pt_json,
      "locales/ru.json": rpivTodo_locales_ru_json,
      "locales/uk.json": rpivTodo_locales_uk_json,
      "locales/zh.json": rpivTodo_locales_zh_json,
      "package.json": rpivTodo_package_json,
      "state/i18n-bridge.ts": rpivTodo_state_i18n_bridge_ts,
      "state/invariants.ts": rpivTodo_state_invariants_ts,
      "state/replay.ts": rpivTodo_state_replay_ts,
      "state/selectors.ts": rpivTodo_state_selectors_ts,
      "state/session.ts": rpivTodo_state_session_ts,
      "state/state-reducer.ts": rpivTodo_state_state_reducer_ts,
      "state/state.ts": rpivTodo_state_state_ts,
      "state/store.ts": rpivTodo_state_store_ts,
      "state/task-graph.ts": rpivTodo_state_task_graph_ts,
      "todo-overlay.ts": rpivTodo_todo_overlay_ts,
      "todo.ts": rpivTodo_todo_ts,
      "tool/response-envelope.ts": rpivTodo_tool_response_envelope_ts,
      "tool/types.ts": rpivTodo_tool_types_ts,
      "vendor/rpiv-config.ts": rpivTodo_vendor_rpiv_config_ts,
      "view/format.ts": rpivTodo_view_format_ts,
    },
    "mpi-prompt-history": {
      "index.ts": promptHistoryIndex,
      "prompt-history-browser.ts": promptHistoryBrowser,
      "package.json": promptHistoryPackageJson,
    },
    "mpi-skill-refs": {
      "index.ts": skillRefsIndex,
      "skill-core.ts": skillRefsCore,
      "package.json": skillRefsPackageJson,
    },
    "mpi-goal": {
      "index.ts": mpiGoal_index_ts,
      "package.json": mpiGoal_package_json,
      "src/app.ts": mpiGoal_src_app_ts,
      "src/domain/active-time.ts": mpiGoal_src_domain_active_time_ts,
      "src/domain/session-scope.ts": mpiGoal_src_domain_session_scope_ts,
      "src/domain/budget.ts": mpiGoal_src_domain_budget_ts,
      "src/domain/completion-gate.ts": mpiGoal_src_domain_completion_gate_ts,
      "src/domain/constants.ts": mpiGoal_src_domain_constants_ts,
      "src/domain/feature-flags.ts": mpiGoal_src_domain_feature_flags_ts,
      "src/domain/floor-steering.ts": mpiGoal_src_domain_floor_steering_ts,
      "src/domain/floor.ts": mpiGoal_src_domain_floor_ts,
      "src/domain/format.ts": mpiGoal_src_domain_format_ts,
      "src/domain/goal-intent.ts": mpiGoal_src_domain_goal_intent_ts,
      "src/domain/telemetry.ts": mpiGoal_src_domain_telemetry_ts,
      "src/domain/types.ts": mpiGoal_src_domain_types_ts,
      "src/persistence/goal-store.ts": mpiGoal_src_persistence_goal_store_ts,
      "src/persistence/queue-store.ts": mpiGoal_src_persistence_queue_store_ts,
      "src/queue/block-parser.ts": mpiGoal_src_queue_block_parser_ts,
      "src/queue/steering.ts": mpiGoal_src_queue_steering_ts,
      "src/runtime/context-reset.ts": mpiGoal_src_runtime_context_reset_ts,
      "src/runtime/continuation-ticket.ts": mpiGoal_src_runtime_continuation_ticket_ts,
      "src/runtime/continuation.ts": mpiGoal_src_runtime_continuation_ts,
      "src/runtime/lifecycle.ts": mpiGoal_src_runtime_lifecycle_ts,
      "src/runtime/post-completion.ts": mpiGoal_src_runtime_post_completion_ts,
      "src/runtime/prompts.ts": mpiGoal_src_runtime_prompts_ts,
      "src/runtime/terminal-workflow.ts": mpiGoal_src_runtime_terminal_workflow_ts,
      "src/surface/command/register.ts": mpiGoal_src_surface_command_register_ts,
      "src/surface/tools/dynamic.ts": mpiGoal_src_surface_tools_dynamic_ts,
      "src/surface/tools/goal-tools.ts": mpiGoal_src_surface_tools_goal_tools_ts,
      "src/surface/tools/names.ts": mpiGoal_src_surface_tools_names_ts,
      "src/surface/tools/queue-tools.ts": mpiGoal_src_surface_tools_queue_tools_ts,
      "src/surface/tools/results.ts": mpiGoal_src_surface_tools_results_ts,
      "src/surface/tools/schemas.ts": mpiGoal_src_surface_tools_schemas_ts,
      "src/surface/ui/goal-overlay.ts": mpiGoal_src_surface_ui_goal_overlay_ts,
      "src/surface/ui/notify.ts": mpiGoal_src_surface_ui_notify_ts,
      "src/surface/ui/widget.ts": mpiGoal_src_surface_ui_widget_ts,
      "src/templates/discover.ts": mpiGoal_src_templates_discover_ts,
    },
    "mpi-auto-rename": {
      "index.ts": autoRenameIndex,
      "package.json": autoRenamePackageJson,
    },
  },
});

process.env.PI_PACKAGE_DIR = runtimeDir;

// Stash the nested pi-tui module on globalThis so the bridge can pick it up
// when it initializes. The bridge reads this symbol during module load.
const NESTED_PI_TUI_SYMBOL = Symbol.for("mixcode-pi.nested-pi-tui");
(globalThis as Record<symbol, unknown>)[NESTED_PI_TUI_SYMBOL] = nestedPiTuiKeybindings;

// Dynamic import ensures PI_PACKAGE_DIR is set before pi-coding-agent loads.
// Bun's compiled executable can make main.ts look like the direct argv[1]
// entrypoint, so mark this import as wrapper-owned before loading it.
const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");
(globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG] = true;
const { main } = await import("./main.js");
await main();
