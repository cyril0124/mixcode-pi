// Standalone binary entry point.
// Must set PI_PACKAGE_DIR BEFORE any other module initializes, because
// pi-coding-agent's config module reads package.json and built-in resources
// eagerly at import/render time.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCtlCliArgs } from "./ctl.js";
import { isStatusCliArgs } from "./status.js";

if (process.versions?.bun && Object.keys(process.env).length === 0) {
  try {
    const data = fs.readFileSync("/proc/self/environ", "utf-8");
    for (const entry of data.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx > 0) {
        process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
  } catch {}
}

const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");

// Fast path for status/ctl: skip OAuth, temp dir, and asset materialization.
if (isStatusCliArgs(process.argv.slice(2)) || isCtlCliArgs(process.argv.slice(2))) {
  (globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG] = true;
  const { main } = await import("./main.js");
  await main();
  process.exit(process.exitCode ?? 0);
}

import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

import darkTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json" with {
  type: "json",
};
import lightTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json" with {
  type: "json",
};
import exportTemplateCss from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.css" with {
  type: "text",
};
import exportTemplateHtml from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html" with {
  type: "text",
};
import exportTemplateJs from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js" with {
  type: "text",
};
import exportVendorMarked from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/marked.min.js" with {
  type: "text",
};
import exportVendorHighlight from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/highlight.min.js" with {
  type: "text",
};
import clankolasImagePath from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets/clankolas.png" with {
  type: "file",
};
import photonWasmPath from "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" with {
  type: "file",
};
import searchGuardIndex from "../../pi-packages/mpi-search-guard/index.ts" with { type: "text" };
import searchGuardPackageJson from "../../pi-packages/mpi-search-guard/package.json" with {
  type: "text",
};
import imageHoistIndex from "../../pi-packages/mpi-image-hoist/index.ts" with { type: "text" };
import imageHoistPackageJson from "../../pi-packages/mpi-image-hoist/package.json" with {
  type: "text",
};
import diffViewerIndex from "../../pi-packages/mpi-diff-viewer/index.ts" with { type: "text" };
import diffViewerSessionDiff from "../../pi-packages/mpi-diff-viewer/session-diff.ts" with {
  type: "text",
};
import diffViewerComponent from "../../pi-packages/mpi-diff-viewer/diff-viewer.ts" with {
  type: "text",
};
import diffViewerReview from "../../pi-packages/mpi-diff-viewer/review.ts" with { type: "text" };
import diffViewerPackageJson from "../../pi-packages/mpi-diff-viewer/package.json" with {
  type: "text",
};
import transcriptIndex from "../../pi-packages/mpi-transcript/index.ts" with { type: "text" };
import transcriptConfig from "../../pi-packages/mpi-transcript/config.ts" with { type: "text" };
import transcriptEditor from "../../pi-packages/mpi-transcript/editor.ts" with { type: "text" };
import transcriptConfigOverlay from "../../pi-packages/mpi-transcript/config-overlay.ts" with {
  type: "text",
};
import transcriptSchemaJson from "../../pi-packages/mpi-transcript/mpi-transcript.schema.json" with {
  type: "text",
};
import transcriptPackageJson from "../../pi-packages/mpi-transcript/package.json" with {
  type: "text",
};
import bashExec from "../../pi-packages/mpi-bash/exec.ts" with { type: "text" };
import bashHeartbeat from "../../pi-packages/mpi-bash/heartbeat.ts" with { type: "text" };
import bashIndex from "../../pi-packages/mpi-bash/index.ts" with { type: "text" };
import bashLogs from "../../pi-packages/mpi-bash/bash-logs.ts" with { type: "text" };
import bashLogView from "../../pi-packages/mpi-bash/log-view.ts" with { type: "text" };
import bashPackageJson from "../../pi-packages/mpi-bash/package.json" with { type: "text" };
import bashWidget from "../../pi-packages/mpi-bash/widget.ts" with { type: "text" };
import toolDisplayIndex from "../../pi-packages/mpi-tool-display/index.ts" with { type: "text" };
import toolDisplayPackageJson from "../../pi-packages/mpi-tool-display/package.json" with {
  type: "text",
};
import toolDisplayConfig from "../../pi-packages/mpi-tool-display/config.ts" with { type: "text" };
import toolDisplayConfigOverlay from "../../pi-packages/mpi-tool-display/config-overlay.ts" with {
  type: "text",
};
import toolDisplayTypes from "../../pi-packages/mpi-tool-display/types.ts" with { type: "text" };
import toolDisplayAnsiUtils from "../../pi-packages/mpi-tool-display/ansi-utils.ts" with {
  type: "text",
};
import toolDisplayRenderUtils from "../../pi-packages/mpi-tool-display/render-utils.ts" with {
  type: "text",
};
import toolDisplayDiffPresentation from "../../pi-packages/mpi-tool-display/diff-presentation.ts" with {
  type: "text",
};
import toolDisplayLineWidthSafety from "../../pi-packages/mpi-tool-display/line-width-safety.ts" with {
  type: "text",
};
import toolDisplayWriteDisplayUtils from "../../pi-packages/mpi-tool-display/write-display-utils.ts" with {
  type: "text",
};
import toolDisplayPendingDiffPreview from "../../pi-packages/mpi-tool-display/pending-diff-preview.ts" with {
  type: "text",
};
import toolDisplayDiffRenderer from "../../pi-packages/mpi-tool-display/diff-renderer.ts" with {
  type: "text",
};
import toolDisplayBashDisplay from "../../pi-packages/mpi-tool-display/bash-display.ts" with {
  type: "text",
};
import toolDisplayDisposable from "../../pi-packages/mpi-tool-display/disposable.ts" with {
  type: "text",
};
import toolDisplayToolSummaries from "../../pi-packages/mpi-tool-display/tool-summaries.ts" with {
  type: "text",
};
import toolDisplayThinkingLabel from "../../pi-packages/mpi-tool-display/thinking-label.ts" with {
  type: "text",
};
import toolDisplayExtensionLifecycle from "../../pi-packages/mpi-tool-display/extension-lifecycle.ts" with {
  type: "text",
};
import toolDisplayToolExecutionAdapter from "../../pi-packages/mpi-tool-display/tool-execution-adapter.ts" with {
  type: "text",
};
import toolDisplayToolCallRenderer from "../../pi-packages/mpi-tool-display/tool-call-renderer.ts" with {
  type: "text",
};
import toolDisplayReadme from "../../pi-packages/mpi-tool-display/README.md" with { type: "text" };
import toolDisplayReadmeZh from "../../pi-packages/mpi-tool-display/README.zh.md" with {
  type: "text",
};
import toolDisplayThirdPartyNotices from "../../pi-packages/mpi-tool-display/THIRD_PARTY_NOTICES.md" with {
  type: "text",
};
import herdrReportIndex from "../../pi-packages/mpi-herdr-report/index.ts" with { type: "text" };
import herdrReportPackageJson from "../../pi-packages/mpi-herdr-report/package.json" with {
  type: "text",
};
import loopIndex from "../../pi-packages/mpi-loop/index.ts" with { type: "text" };
import loopHelpers from "../../pi-packages/mpi-loop/loop-helpers.ts" with { type: "text" };
import loopManagementView from "../../pi-packages/mpi-loop/loop-management-view.ts" with {
  type: "text",
};
import loopPackageJson from "../../pi-packages/mpi-loop/package.json" with { type: "text" };
import skillRefsIndex from "../../pi-packages/mpi-skill-refs/index.ts" with { type: "text" };
import skillRefsCore from "../../pi-packages/mpi-skill-refs/skill-core.ts" with { type: "text" };
import skillRefsPackageJson from "../../pi-packages/mpi-skill-refs/package.json" with {
  type: "text",
};
import stuckGuardIndex from "../../pi-packages/mpi-stuck-guard/index.ts" with { type: "text" };
import stuckGuardProviderWatchdog from "../../pi-packages/mpi-stuck-guard/provider-watchdog.ts" with {
  type: "text",
};
import stuckGuardProviderWrapper from "../../pi-packages/mpi-stuck-guard/provider-wrapper.ts" with {
  type: "text",
};
import stuckGuardConfig from "../../pi-packages/mpi-stuck-guard/config.ts" with { type: "text" };
import stuckGuardConfigCommand from "../../pi-packages/mpi-stuck-guard/config-command.ts" with {
  type: "text",
};
import stuckGuardConfigOverlay from "../../pi-packages/mpi-stuck-guard/config-overlay.ts" with {
  type: "text",
};
import stuckGuardProviderPicker from "../../pi-packages/mpi-stuck-guard/provider-picker.ts" with {
  type: "text",
};
import stuckGuardStats from "../../pi-packages/mpi-stuck-guard/stats.ts" with { type: "text" };
import stuckGuardStatsOverlay from "../../pi-packages/mpi-stuck-guard/stats-overlay.ts" with {
  type: "text",
};
import stuckGuardSchemaJson from "../../pi-packages/mpi-stuck-guard/mpi-stuck-guard.schema.json" with {
  type: "text",
};
import stuckGuardPackageJson from "../../pi-packages/mpi-stuck-guard/package.json" with {
  type: "text",
};
import mpiCtlIndex from "../../pi-packages/mpi-ctl/index.ts" with { type: "text" };
import mpiCtlPackageJson from "../../pi-packages/mpi-ctl/package.json" with { type: "text" };
import mpiCtlSkillMd from "../../pi-packages/mpi-ctl/skills/mpi-ctl/SKILL.md" with { type: "text" };
import mpiGoal_index_ts from "../../pi-packages/mpi-goal/index.ts" with { type: "text" };
import mpiGoal_package_json from "../../pi-packages/mpi-goal/package.json" with { type: "text" };
import mpiGoal_src_app_ts from "../../pi-packages/mpi-goal/src/app.ts" with { type: "text" };
import mpiGoal_src_shell_ts from "../../pi-packages/mpi-goal/src/shell.ts" with { type: "text" };
import mpiGoal_src_session_gate_ts from "../../pi-packages/mpi-goal/src/session-gate.ts" with {
  type: "text",
};
import mpiGoal_src_domain_active_time_ts from "../../pi-packages/mpi-goal/src/domain/active-time.ts" with {
  type: "text",
};
import mpiGoal_src_domain_session_scope_ts from "../../pi-packages/mpi-goal/src/domain/session-scope.ts" with {
  type: "text",
};
import mpiGoal_src_domain_budget_ts from "../../pi-packages/mpi-goal/src/domain/budget.ts" with {
  type: "text",
};
import mpiGoal_src_domain_completion_gate_ts from "../../pi-packages/mpi-goal/src/domain/completion-gate.ts" with {
  type: "text",
};
import mpiGoal_src_domain_constants_ts from "../../pi-packages/mpi-goal/src/domain/constants.ts" with {
  type: "text",
};
import mpiGoal_src_domain_floor_steering_ts from "../../pi-packages/mpi-goal/src/domain/floor-steering.ts" with {
  type: "text",
};
import mpiGoal_src_domain_floor_ts from "../../pi-packages/mpi-goal/src/domain/floor.ts" with {
  type: "text",
};
import mpiGoal_src_domain_format_ts from "../../pi-packages/mpi-goal/src/domain/format.ts" with {
  type: "text",
};
import mpiGoal_src_domain_goal_intent_ts from "../../pi-packages/mpi-goal/src/domain/goal-intent.ts" with {
  type: "text",
};
import mpiGoal_src_domain_telemetry_ts from "../../pi-packages/mpi-goal/src/domain/telemetry.ts" with {
  type: "text",
};
import mpiGoal_src_domain_types_ts from "../../pi-packages/mpi-goal/src/domain/types.ts" with {
  type: "text",
};
import mpiGoal_src_persistence_goal_store_ts from "../../pi-packages/mpi-goal/src/persistence/goal-store.ts" with {
  type: "text",
};
import mpiGoal_src_persistence_queue_store_ts from "../../pi-packages/mpi-goal/src/persistence/queue-store.ts" with {
  type: "text",
};
import mpiGoal_src_queue_block_parser_ts from "../../pi-packages/mpi-goal/src/queue/block-parser.ts" with {
  type: "text",
};
import mpiGoal_src_queue_steering_ts from "../../pi-packages/mpi-goal/src/queue/steering.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_context_reset_ts from "../../pi-packages/mpi-goal/src/runtime/context-reset.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_continuation_ticket_ts from "../../pi-packages/mpi-goal/src/runtime/continuation-ticket.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_continuation_ts from "../../pi-packages/mpi-goal/src/runtime/continuation.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_lifecycle_ts from "../../pi-packages/mpi-goal/src/runtime/lifecycle.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_post_completion_ts from "../../pi-packages/mpi-goal/src/runtime/post-completion.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_prompts_ts from "../../pi-packages/mpi-goal/src/runtime/prompts.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_terminal_workflow_ts from "../../pi-packages/mpi-goal/src/runtime/terminal-workflow.ts" with {
  type: "text",
};
import mpiGoal_src_surface_command_register_ts from "../../pi-packages/mpi-goal/src/surface/command/register.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_dynamic_ts from "../../pi-packages/mpi-goal/src/surface/tools/dynamic.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_goal_tools_ts from "../../pi-packages/mpi-goal/src/surface/tools/goal-tools.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_names_ts from "../../pi-packages/mpi-goal/src/surface/tools/names.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_queue_tools_ts from "../../pi-packages/mpi-goal/src/surface/tools/queue-tools.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_results_ts from "../../pi-packages/mpi-goal/src/surface/tools/results.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_schemas_ts from "../../pi-packages/mpi-goal/src/surface/tools/schemas.ts" with {
  type: "text",
};
import mpiGoal_src_surface_ui_goal_overlay_ts from "../../pi-packages/mpi-goal/src/surface/ui/goal-overlay.ts" with {
  type: "text",
};
import mpiGoal_src_surface_ui_notify_ts from "../../pi-packages/mpi-goal/src/surface/ui/notify.ts" with {
  type: "text",
};
import mpiGoal_src_surface_ui_widget_ts from "../../pi-packages/mpi-goal/src/surface/ui/widget.ts" with {
  type: "text",
};
import mpiGoal_src_templates_discover_ts from "../../pi-packages/mpi-goal/src/templates/discover.ts" with {
  type: "text",
};
import promptHistoryIndex from "../../pi-packages/mpi-prompt-history/index.ts" with {
  type: "text",
};
import promptHistoryBrowser from "../../pi-packages/mpi-prompt-history/prompt-history-browser.ts" with {
  type: "text",
};
import promptHistoryStore from "../../pi-packages/mpi-prompt-history/history-store.ts" with {
  type: "text",
};
import promptHistoryPidLock from "../../pi-packages/mpi-prompt-history/pid-lock.ts" with {
  type: "text",
};
import promptHistoryConfigUi from "../../pi-packages/mpi-prompt-history/config-ui.ts" with {
  type: "text",
};
import promptHistorySchemaJson from "../../pi-packages/mpi-prompt-history/mpi-prompt-history.schema.json" with {
  type: "text",
};
import promptHistoryPackageJson from "../../pi-packages/mpi-prompt-history/package.json" with {
  type: "text",
};
import autoRenameIndex from "../../pi-packages/mpi-auto-rename/index.ts" with { type: "text" };
import autoRenameConfig from "../../pi-packages/mpi-auto-rename/config.ts" with { type: "text" };
import autoRenameConfigOverlay from "../../pi-packages/mpi-auto-rename/config-overlay.ts" with {
  type: "text",
};
import autoRenamePackageJson from "../../pi-packages/mpi-auto-rename/package.json" with {
  type: "text",
};
import autoRenameSchemaJson from "../../pi-packages/mpi-auto-rename/mpi-auto-rename.schema.json" with {
  type: "text",
};
import optimizePromptIndex from "../../pi-packages/mpi-optimize-prompt/index.ts" with {
  type: "text",
};
import optimizePromptCore from "../../pi-packages/mpi-optimize-prompt/core.ts" with {
  type: "text",
};
import optimizePromptConfig from "../../pi-packages/mpi-optimize-prompt/config.ts" with {
  type: "text",
};
import optimizePromptConfigOverlay from "../../pi-packages/mpi-optimize-prompt/config-overlay.ts" with {
  type: "text",
};
import optimizePromptPackageJson from "../../pi-packages/mpi-optimize-prompt/package.json" with {
  type: "text",
};
import optimizePromptSchemaJson from "../../pi-packages/mpi-optimize-prompt/mpi-optimize-prompt.schema.json" with {
  type: "text",
};
import lengthResumeIndex from "../../pi-packages/mpi-length-resume/index.ts" with { type: "text" };
import lengthResumePackageJson from "../../pi-packages/mpi-length-resume/package.json" with {
  type: "text",
};
import modelSkillsIndex from "../../pi-packages/mpi-model-skills/index.ts" with { type: "text" };
import modelSkillsCore from "../../pi-packages/mpi-model-skills/model-skills-core.ts" with {
  type: "text",
};
import modelSkillsPackageJson from "../../pi-packages/mpi-model-skills/package.json" with {
  type: "text",
};
import modelSkillsSchemaJson from "../../pi-packages/mpi-model-skills/mpi-model-skills.schema.json" with {
  type: "text",
};
import modelExtensionsIndex from "../../pi-packages/mpi-model-extensions/index.ts" with {
  type: "text",
};
import modelExtensionsCore from "../../pi-packages/mpi-model-extensions/model-extensions-core.ts" with {
  type: "text",
};
import modelExtensionsLoader from "../../pi-packages/mpi-model-extensions/model-extensions-loader.ts" with {
  type: "text",
};
import modelExtensionsPackageJson from "../../pi-packages/mpi-model-extensions/package.json" with {
  type: "text",
};
import modelExtensionsSchemaJson from "../../pi-packages/mpi-model-extensions/mpi-model-extensions.schema.json" with {
  type: "text",
};
import permissionIndex from "../../pi-packages/mpi-permission/index.ts" with { type: "text" };
import permissionCore from "../../pi-packages/mpi-permission/permission-core.ts" with {
  type: "text",
};
import permissionBashPolicy from "../../pi-packages/mpi-permission/bash-policy.ts" with {
  type: "text",
};
import permissionOverlay from "../../pi-packages/mpi-permission/permission-overlay.ts" with {
  type: "text",
};
import permissionPackageJson from "../../pi-packages/mpi-permission/package.json" with {
  type: "text",
};
import permissionSchemaJson from "../../pi-packages/mpi-permission/mpi-permission.schema.json" with {
  type: "text",
};
import permissionUnbashJs from "../../pi-packages/mpi-permission/vendor/unbash.js" with {
  type: "text",
};
import permissionUnbashDts from "../../pi-packages/mpi-permission/vendor/unbash.d.ts" with {
  type: "text",
};
import permissionUnbashTypesDts from "../../pi-packages/mpi-permission/vendor/unbash-types.d.ts" with {
  type: "text",
};
import permissionUnbashLicense from "../../pi-packages/mpi-permission/vendor/UNBASH-LICENSE" with {
  type: "text",
};
import permissionUnbashNotice from "../../pi-packages/mpi-permission/vendor/UNBASH-NOTICE" with {
  type: "text",
};
import permissionSkillMd from "../../pi-packages/mpi-permission/skills/mpi-permission/SKILL.md" with {
  type: "text",
};
import toolBlockIndex from "../../pi-packages/mpi-tool-block/index.ts" with { type: "text" };
import toolBlockCore from "../../pi-packages/mpi-tool-block/tool-block-core.ts" with {
  type: "text",
};
import toolBlockOverlay from "../../pi-packages/mpi-tool-block/tool-block-overlay.ts" with {
  type: "text",
};
import toolBlockPackageJson from "../../pi-packages/mpi-tool-block/package.json" with {
  type: "text",
};
import toolBlockSchemaJson from "../../pi-packages/mpi-tool-block/mpi-tool-block.schema.json" with {
  type: "text",
};
// Documentation embedded for the system-prompt pointers; the binary has no
// package tree on disk, so these are installed to <agentDir>/mixcode-docs.
import mixcodeDoc_README_md from "../../docs/README.md" with { type: "text" };
import mixcodeDoc_architecture_md from "../../docs/architecture.md" with { type: "text" };
import mixcodeDoc_batch_scripts_md from "../../docs/batch-scripts.md" with { type: "text" };
import mixcodeDoc_builtin_extensions_md from "../../docs/builtin-extensions.md" with {
  type: "text",
};
import mixcodeDoc_cli_and_flags_md from "../../docs/cli-and-flags.md" with { type: "text" };
import mixcodeDoc_commands_md from "../../docs/commands.md" with { type: "text" };
import mixcodeDoc_environment_md from "../../docs/environment.md" with { type: "text" };
import mixcodeDoc_extension_compatibility_md from "../../docs/extension-compatibility.md" with {
  type: "text",
};
import mixcodeDoc_extension_ui_and_widgets_md from "../../docs/extension-ui-and-widgets.md" with {
  type: "text",
};
import mixcodeDoc_inline_widgets_md from "../../docs/inline-widgets.md" with { type: "text" };
import mixcodeDoc_instance_registry_md from "../../docs/instance-registry.md" with { type: "text" };
import mixcodeDoc_keybindings_and_escape_md from "../../docs/keybindings-and-escape.md" with {
  type: "text",
};
import mixcodeDoc_mixcode_settings_md from "../../docs/mixcode-settings.md" with { type: "text" };
import mixcodeDoc_model_management_md from "../../docs/model-management.md" with { type: "text" };
import mixcodeDoc_mouse_support_md from "../../docs/mouse-support.md" with { type: "text" };
import mixcodeDoc_narrow_terminals_and_mobile_md from "../../docs/narrow-terminals-and-mobile.md" with {
  type: "text",
};
import mixcodeDoc_queue_and_follow_up_md from "../../docs/queue-and-follow-up.md" with {
  type: "text",
};
import mixcodeDoc_tui_components_md from "../../docs/tui-components.md" with { type: "text" };
import mixcodeDoc_vim_and_navigation_md from "../../docs/vim-and-navigation.md" with {
  type: "text",
};
import mixcodeDoc_workspace_and_tabs_md from "../../docs/workspace-and-tabs.md" with {
  type: "text",
};
import mixcodeDoc_zen_mode_md from "../../docs/zen-mode.md" with { type: "text" };
import packageJson from "../../package.json" with { type: "json" };
import { installMixcodeDocs, materializeBinaryRuntimeAssets } from "./binary-assets.js";
import { resolveMixcodeAgentDir } from "../core/paths.js";

// Static import of the nested pi-tui keybindings module that pi-coding-agent
// ships via its shrinkwrap. In a compiled binary, runtime module resolution
// (import.meta.resolve / createRequire) cannot locate this nested copy, so we
// import it statically and stash it on globalThis for the bridge to pick up.
// We cannot import the bridge directly here because it transitively pulls in
// pi-coding-agent which reads PI_PACKAGE_DIR eagerly (not yet set at this point).
import * as nestedPiTuiKeybindings from "../../node_modules/@earendil-works/pi-tui/dist/keybindings.js";

// jiti caches compiled extension modules to <os.tmpdir()>/jiti. On shared
// hosts that directory can be owned by another user, which silently disables
// the cache: every boot then re-transforms every extension in pure JS
// (compiled binaries force tryNative:false). Detect the occupied directory
// and redirect TMPDIR to a private sibling on the same (local) disk so jiti
// and spawned children keep local-disk temp IO. Pre-setting any writable
// TMPDIR skips the redirect entirely.
function ensureJitiCacheWritable(): void {
  const jitiDir = path.join(os.tmpdir(), "jiti");
  try {
    fs.mkdirSync(jitiDir, { recursive: true });
    fs.accessSync(jitiDir, fs.constants.W_OK);
    return;
  } catch {
    // Occupied by another user or otherwise unwritable — redirect below.
  }
  const fallback = path.join(os.tmpdir(), `${os.userInfo().username}-mixcode-tmp`);
  try {
    fs.mkdirSync(fallback, { recursive: true });
    process.env.TMPDIR = fallback;
    process.stderr.write(
      `[mixcode] jiti cache dir ${jitiDir} is not writable; TMPDIR redirected to ${fallback}\n`,
    );
  } catch {
    // No writable fallback either — keep the original TMPDIR; jiti then runs
    // without its disk cache and re-transforms extensions on each boot.
  }
}
ensureJitiCacheWritable();

// Sync mkdtemp/rm for process-exit cleanup (no async allowed on exit handlers).
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-pi-"));

function cleanup() {
  try {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
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

await materializeBinaryRuntimeAssets(runtimeDir, {
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
    "mpi-diff-viewer": {
      "index.ts": diffViewerIndex,
      "session-diff.ts": diffViewerSessionDiff,
      "diff-viewer.ts": diffViewerComponent,
      "review.ts": diffViewerReview,
      "package.json": diffViewerPackageJson,
    },
    "mpi-transcript": {
      "index.ts": transcriptIndex,
      "config.ts": transcriptConfig,
      "editor.ts": transcriptEditor,
      "config-overlay.ts": transcriptConfigOverlay,
      "mpi-transcript.schema.json": transcriptSchemaJson,
      "package.json": transcriptPackageJson,
    },
    "mpi-bash": {
      "index.ts": bashIndex,
      "exec.ts": bashExec,
      "widget.ts": bashWidget,
      "bash-logs.ts": bashLogs,
      "log-view.ts": bashLogView,
      "heartbeat.ts": bashHeartbeat,
      "package.json": bashPackageJson,
    },
    "mpi-tool-display": {
      "index.ts": toolDisplayIndex,
      "package.json": toolDisplayPackageJson,
      "config.ts": toolDisplayConfig,
      "config-overlay.ts": toolDisplayConfigOverlay,
      "types.ts": toolDisplayTypes,
      "ansi-utils.ts": toolDisplayAnsiUtils,
      "render-utils.ts": toolDisplayRenderUtils,
      "diff-presentation.ts": toolDisplayDiffPresentation,
      "line-width-safety.ts": toolDisplayLineWidthSafety,
      "write-display-utils.ts": toolDisplayWriteDisplayUtils,
      "pending-diff-preview.ts": toolDisplayPendingDiffPreview,
      "diff-renderer.ts": toolDisplayDiffRenderer,
      "bash-display.ts": toolDisplayBashDisplay,
      "disposable.ts": toolDisplayDisposable,
      "tool-summaries.ts": toolDisplayToolSummaries,
      "thinking-label.ts": toolDisplayThinkingLabel,
      "extension-lifecycle.ts": toolDisplayExtensionLifecycle,
      "tool-execution-adapter.ts": toolDisplayToolExecutionAdapter,
      "tool-call-renderer.ts": toolDisplayToolCallRenderer,
      "README.md": toolDisplayReadme,
      "README.zh.md": toolDisplayReadmeZh,
      "THIRD_PARTY_NOTICES.md": toolDisplayThirdPartyNotices,
    },
    "mpi-herdr-report": {
      "index.ts": herdrReportIndex,
      "package.json": herdrReportPackageJson,
    },
    "mpi-loop": {
      "index.ts": loopIndex,
      "loop-helpers.ts": loopHelpers,
      "loop-management-view.ts": loopManagementView,
      "package.json": loopPackageJson,
    },
    "mpi-prompt-history": {
      "index.ts": promptHistoryIndex,
      "prompt-history-browser.ts": promptHistoryBrowser,
      "history-store.ts": promptHistoryStore,
      "pid-lock.ts": promptHistoryPidLock,
      "config-ui.ts": promptHistoryConfigUi,
      "mpi-prompt-history.schema.json": promptHistorySchemaJson,
      "package.json": promptHistoryPackageJson,
    },
    "mpi-skill-refs": {
      "index.ts": skillRefsIndex,
      "skill-core.ts": skillRefsCore,
      "package.json": skillRefsPackageJson,
    },
    "mpi-stuck-guard": {
      "index.ts": stuckGuardIndex,
      "provider-watchdog.ts": stuckGuardProviderWatchdog,
      "provider-wrapper.ts": stuckGuardProviderWrapper,
      "config.ts": stuckGuardConfig,
      "config-command.ts": stuckGuardConfigCommand,
      "config-overlay.ts": stuckGuardConfigOverlay,
      "provider-picker.ts": stuckGuardProviderPicker,
      "stats.ts": stuckGuardStats,
      "stats-overlay.ts": stuckGuardStatsOverlay,
      "mpi-stuck-guard.schema.json": stuckGuardSchemaJson,
      "package.json": stuckGuardPackageJson,
    },
    "mpi-ctl": {
      "index.ts": mpiCtlIndex,
      "package.json": mpiCtlPackageJson,
      "skills/mpi-ctl/SKILL.md": mpiCtlSkillMd,
    },
    "mpi-goal": {
      "index.ts": mpiGoal_index_ts,
      "package.json": mpiGoal_package_json,
      "src/app.ts": mpiGoal_src_app_ts,
      "src/shell.ts": mpiGoal_src_shell_ts,
      "src/session-gate.ts": mpiGoal_src_session_gate_ts,
      "src/domain/active-time.ts": mpiGoal_src_domain_active_time_ts,
      "src/domain/session-scope.ts": mpiGoal_src_domain_session_scope_ts,
      "src/domain/budget.ts": mpiGoal_src_domain_budget_ts,
      "src/domain/completion-gate.ts": mpiGoal_src_domain_completion_gate_ts,
      "src/domain/constants.ts": mpiGoal_src_domain_constants_ts,
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
    "mpi-permission": {
      "index.ts": permissionIndex,
      "permission-core.ts": permissionCore,
      "bash-policy.ts": permissionBashPolicy,
      "permission-overlay.ts": permissionOverlay,
      "package.json": permissionPackageJson,
      "mpi-permission.schema.json": permissionSchemaJson,
      "vendor/unbash.js": permissionUnbashJs,
      "vendor/unbash.d.ts": permissionUnbashDts,
      "vendor/unbash-types.d.ts": permissionUnbashTypesDts,
      "vendor/UNBASH-LICENSE": permissionUnbashLicense,
      "vendor/UNBASH-NOTICE": permissionUnbashNotice,
      "skills/mpi-permission/SKILL.md": permissionSkillMd,
    },
    "mpi-auto-rename": {
      "index.ts": autoRenameIndex,
      "config.ts": autoRenameConfig,
      "config-overlay.ts": autoRenameConfigOverlay,
      "package.json": autoRenamePackageJson,
      "mpi-auto-rename.schema.json": autoRenameSchemaJson,
    },
    "mpi-optimize-prompt": {
      "index.ts": optimizePromptIndex,
      "core.ts": optimizePromptCore,
      "config.ts": optimizePromptConfig,
      "config-overlay.ts": optimizePromptConfigOverlay,
      "package.json": optimizePromptPackageJson,
      "mpi-optimize-prompt.schema.json": optimizePromptSchemaJson,
    },
    "mpi-length-resume": {
      "index.ts": lengthResumeIndex,
      "package.json": lengthResumePackageJson,
    },
    "mpi-model-skills": {
      "index.ts": modelSkillsIndex,
      "model-skills-core.ts": modelSkillsCore,
      "package.json": modelSkillsPackageJson,
      "mpi-model-skills.schema.json": modelSkillsSchemaJson,
    },
    "mpi-model-extensions": {
      "index.ts": modelExtensionsIndex,
      "model-extensions-core.ts": modelExtensionsCore,
      "model-extensions-loader.ts": modelExtensionsLoader,
      "package.json": modelExtensionsPackageJson,
      "mpi-model-extensions.schema.json": modelExtensionsSchemaJson,
    },
    "mpi-tool-block": {
      "index.ts": toolBlockIndex,
      "tool-block-core.ts": toolBlockCore,
      "tool-block-overlay.ts": toolBlockOverlay,
      "package.json": toolBlockPackageJson,
      "mpi-tool-block.schema.json": toolBlockSchemaJson,
    },
  },
});

// MixCode's own docs go to the stable agent dir, not the per-process runtime
// dir: findMixcodeDocsPath falls back there when no source tree is reachable.
await installMixcodeDocs(resolveMixcodeAgentDir(), {
  "README.md": mixcodeDoc_README_md,
  "architecture.md": mixcodeDoc_architecture_md,
  "batch-scripts.md": mixcodeDoc_batch_scripts_md,
  "builtin-extensions.md": mixcodeDoc_builtin_extensions_md,
  "cli-and-flags.md": mixcodeDoc_cli_and_flags_md,
  "commands.md": mixcodeDoc_commands_md,
  "environment.md": mixcodeDoc_environment_md,
  "extension-compatibility.md": mixcodeDoc_extension_compatibility_md,
  "extension-ui-and-widgets.md": mixcodeDoc_extension_ui_and_widgets_md,
  "inline-widgets.md": mixcodeDoc_inline_widgets_md,
  "instance-registry.md": mixcodeDoc_instance_registry_md,
  "keybindings-and-escape.md": mixcodeDoc_keybindings_and_escape_md,
  "mixcode-settings.md": mixcodeDoc_mixcode_settings_md,
  "model-management.md": mixcodeDoc_model_management_md,
  "mouse-support.md": mixcodeDoc_mouse_support_md,
  "narrow-terminals-and-mobile.md": mixcodeDoc_narrow_terminals_and_mobile_md,
  "queue-and-follow-up.md": mixcodeDoc_queue_and_follow_up_md,
  "tui-components.md": mixcodeDoc_tui_components_md,
  "vim-and-navigation.md": mixcodeDoc_vim_and_navigation_md,
  "workspace-and-tabs.md": mixcodeDoc_workspace_and_tabs_md,
  "zen-mode.md": mixcodeDoc_zen_mode_md,
});

process.env.PI_PACKAGE_DIR = runtimeDir;

// Stash the nested pi-tui module on globalThis so the bridge can pick it up
// when it initializes. The bridge reads this symbol during module load.
const NESTED_PI_TUI_SYMBOL = Symbol.for("mixcode-pi.nested-pi-tui");
(globalThis as Record<symbol, unknown>)[NESTED_PI_TUI_SYMBOL] = nestedPiTuiKeybindings;

// Dynamic import ensures PI_PACKAGE_DIR is set before pi-coding-agent loads.
// Bun's compiled executable can make main.ts look like the direct argv[1]
// entrypoint, so mark this import as wrapper-owned before loading it.
(globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG] = true;
const { main } = await import("./main.js");
await main();
