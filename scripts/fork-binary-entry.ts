// Standalone binary entry point.
// Must set PI_PACKAGE_DIR BEFORE any other module initializes, because
// pi-coding-agent's config module reads package.json and built-in resources
// eagerly at import/render time.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

import auroraTheme from "../vendor/pi/packages/coding-agent/src/modes/interactive/theme/aurora.json" with {
  type: "json",
};
import darkTheme from "../vendor/pi/packages/coding-agent/src/modes/interactive/theme/dark.json" with {
  type: "json",
};
import lightTheme from "../vendor/pi/packages/coding-agent/src/modes/interactive/theme/light.json" with {
  type: "json",
};
import exportTemplateCss from "../vendor/pi/packages/coding-agent/src/core/export-html/template.css" with {
  type: "text",
};
import exportTemplateHtml from "../vendor/pi/packages/coding-agent/src/core/export-html/template.html" with {
  type: "text",
};
import exportTemplateJs from "../vendor/pi/packages/coding-agent/src/core/export-html/template.js" with {
  type: "text",
};
import exportVendorMarked from "../vendor/pi/packages/coding-agent/src/core/export-html/vendor/marked.min.js" with {
  type: "text",
};
import exportVendorMarkedCjk from "../vendor/pi/packages/coding-agent/src/core/export-html/vendor/marked-cjk-friendly.min.js" with {
  type: "text",
};
import exportVendorHighlight from "../vendor/pi/packages/coding-agent/src/core/export-html/vendor/highlight.min.js" with {
  type: "text",
};
import clankolasImagePath from "../vendor/pi/packages/coding-agent/src/modes/interactive/assets/clankolas.png" with {
  type: "file",
};
import photonWasmPath from "../vendor/pi/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" with {
  type: "file",
};
import darwinArm64Helper from "../vendor/pi/packages/tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node" with {
  type: "file",
};
import darwinX64Helper from "../vendor/pi/packages/tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node" with {
  type: "file",
};
import linuxArm64Helper from "../vendor/pi/packages/tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node" with {
  type: "file",
};
import linuxX64Helper from "../vendor/pi/packages/tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node" with {
  type: "file",
};
import win32Arm64Helper from "../vendor/pi/packages/tui/native/win32/prebuilds/win32-arm64/win32-platform.node" with {
  type: "file",
};
import win32X64Helper from "../vendor/pi/packages/tui/native/win32/prebuilds/win32-x64/win32-platform.node" with {
  type: "file",
};
import diffViewerIndex from "../pi-packages/mpi-diff-viewer/index.ts" with { type: "text" };
import diffViewerSessionDiff from "../pi-packages/mpi-diff-viewer/session-diff.ts" with {
  type: "text",
};
import diffViewerComponent from "../pi-packages/mpi-diff-viewer/diff-viewer.ts" with {
  type: "text",
};
import diffViewerReview from "../pi-packages/mpi-diff-viewer/review.ts" with { type: "text" };
import diffViewerPackageJson from "../pi-packages/mpi-diff-viewer/package.json" with {
  type: "text",
};
import transcriptIndex from "../pi-packages/mpi-transcript/index.ts" with { type: "text" };
import transcriptCacheMiss from "../pi-packages/mpi-transcript/cache-miss.ts" with { type: "text" };
import transcriptConfig from "../pi-packages/mpi-transcript/config.ts" with { type: "text" };
import transcriptEditor from "../pi-packages/mpi-transcript/editor.ts" with { type: "text" };
import transcriptConfigOverlay from "../pi-packages/mpi-transcript/config-overlay.ts" with {
  type: "text",
};
import transcriptSchemaJson from "../pi-packages/mpi-transcript/mpi-transcript.schema.json" with {
  type: "text",
};
import transcriptPackageJson from "../pi-packages/mpi-transcript/package.json" with {
  type: "text",
};
import commandRouterIndex from "../pi-packages/mpi-command-router/index.ts" with { type: "text" };
import commandRouterConfig from "../pi-packages/mpi-command-router/config.ts" with { type: "text" };
import commandRouterRouter from "../pi-packages/mpi-command-router/router.ts" with { type: "text" };
import commandRouterSchema from "../pi-packages/mpi-command-router/mpi-command-router.schema.json" with {
  type: "text",
};
import commandRouterSkill from "../pi-packages/mpi-command-router/skills/mpi-command-router/SKILL.md" with {
  type: "text",
};
import commandRouterPackageJson from "../pi-packages/mpi-command-router/package.json" with {
  type: "text",
};
import commandRouterReadme from "../pi-packages/mpi-command-router/README.md" with { type: "text" };
import commandRouterReadmeZh from "../pi-packages/mpi-command-router/README.zh.md" with {
  type: "text",
};
import bashExec from "../pi-packages/mpi-bash/exec.ts" with { type: "text" };
import bashHeartbeat from "../pi-packages/mpi-bash/heartbeat.ts" with { type: "text" };
import bashIndex from "../pi-packages/mpi-bash/index.ts" with { type: "text" };
import bashLogs from "../pi-packages/mpi-bash/bash-logs.ts" with { type: "text" };
import bashLogView from "../pi-packages/mpi-bash/log-view.ts" with { type: "text" };
import bashPackageJson from "../pi-packages/mpi-bash/package.json" with { type: "text" };
import bashToolDisplayConfig from "../pi-packages/mpi-bash/tool-display-config.ts" with {
  type: "text",
};
import bashWidget from "../pi-packages/mpi-bash/widget.ts" with { type: "text" };
import toolDisplayIndex from "../pi-packages/mpi-tool-display/index.ts" with { type: "text" };
import toolDisplayPackageJson from "../pi-packages/mpi-tool-display/package.json" with {
  type: "text",
};
import toolDisplayConfig from "../pi-packages/mpi-tool-display/config.ts" with { type: "text" };
import toolDisplayConfigOverlay from "../pi-packages/mpi-tool-display/config-overlay.ts" with {
  type: "text",
};
import toolDisplayTypes from "../pi-packages/mpi-tool-display/types.ts" with { type: "text" };
import toolDisplayAnsiUtils from "../pi-packages/mpi-tool-display/ansi-utils.ts" with {
  type: "text",
};
import toolDisplayRenderUtils from "../pi-packages/mpi-tool-display/render-utils.ts" with {
  type: "text",
};
import toolDisplayDiffPresentation from "../pi-packages/mpi-tool-display/diff-presentation.ts" with {
  type: "text",
};
import toolDisplayLineWidthSafety from "../pi-packages/mpi-tool-display/line-width-safety.ts" with {
  type: "text",
};
import toolDisplayWriteDisplayUtils from "../pi-packages/mpi-tool-display/write-display-utils.ts" with {
  type: "text",
};
import toolDisplayPendingDiffPreview from "../pi-packages/mpi-tool-display/pending-diff-preview.ts" with {
  type: "text",
};
import toolDisplayDiffRenderer from "../pi-packages/mpi-tool-display/diff-renderer.ts" with {
  type: "text",
};
import toolDisplayBashDisplay from "../pi-packages/mpi-tool-display/bash-display.ts" with {
  type: "text",
};
import toolDisplayDisposable from "../pi-packages/mpi-tool-display/disposable.ts" with {
  type: "text",
};
import toolDisplayToolSummaries from "../pi-packages/mpi-tool-display/tool-summaries.ts" with {
  type: "text",
};
import toolDisplayThinkingLabel from "../pi-packages/mpi-tool-display/thinking-label.ts" with {
  type: "text",
};
import toolDisplayExtensionLifecycle from "../pi-packages/mpi-tool-display/extension-lifecycle.ts" with {
  type: "text",
};
import toolDisplayToolCallRenderer from "../pi-packages/mpi-tool-display/tool-call-renderer.ts" with {
  type: "text",
};
import toolDisplayReadme from "../pi-packages/mpi-tool-display/README.md" with { type: "text" };
import toolDisplayReadmeZh from "../pi-packages/mpi-tool-display/README.zh.md" with {
  type: "text",
};
import toolDisplayThirdPartyNotices from "../pi-packages/mpi-tool-display/THIRD_PARTY_NOTICES.md" with {
  type: "text",
};
import herdrReportIndex from "../pi-packages/mpi-herdr-report/index.ts" with { type: "text" };
import herdrReportPackageJson from "../pi-packages/mpi-herdr-report/package.json" with {
  type: "text",
};
import loopIndex from "../pi-packages/mpi-loop/index.ts" with { type: "text" };
import loopHelpers from "../pi-packages/mpi-loop/loop-helpers.ts" with { type: "text" };
import loopManagementView from "../pi-packages/mpi-loop/loop-management-view.ts" with {
  type: "text",
};
import loopPackageJson from "../pi-packages/mpi-loop/package.json" with { type: "text" };
import cronIndex from "../pi-packages/mpi-cron/index.ts" with { type: "text" };
import cronCronEngine from "../pi-packages/mpi-cron/cron-engine.ts" with { type: "text" };
import cronStorage from "../pi-packages/mpi-cron/storage.ts" with { type: "text" };
import cronHub from "../pi-packages/mpi-cron/hub.ts" with { type: "text" };
import cronTypes from "../pi-packages/mpi-cron/types.ts" with { type: "text" };
import cronTool from "../pi-packages/mpi-cron/tool.ts" with { type: "text" };
import cronCronWidget from "../pi-packages/mpi-cron/cron-widget.ts" with { type: "text" };
import cronCronManagementView from "../pi-packages/mpi-cron/cron-management-view.ts" with {
  type: "text",
};
import cronPackageJson from "../pi-packages/mpi-cron/package.json" with { type: "text" };
import skillRefsIndex from "../pi-packages/mpi-skill-refs/index.ts" with { type: "text" };
import skillRefsCore from "../pi-packages/mpi-skill-refs/skill-core.ts" with { type: "text" };
import skillRefsReadme from "../pi-packages/mpi-skill-refs/README.md" with { type: "text" };
import skillRefsReadmeZh from "../pi-packages/mpi-skill-refs/README.zh.md" with { type: "text" };
import skillRefsPackageJson from "../pi-packages/mpi-skill-refs/package.json" with { type: "text" };
import stuckGuardDoomLoop from "../pi-packages/mpi-stuck-guard/doom-loop.ts" with { type: "text" };
import stuckGuardReadProgress from "../pi-packages/mpi-stuck-guard/read-progress.ts" with {
  type: "text",
};
import stuckGuardCycleDetection from "../pi-packages/mpi-stuck-guard/cycle-detection.ts" with {
  type: "text",
};
import stuckGuardReadme from "../pi-packages/mpi-stuck-guard/README.md" with { type: "text" };
import stuckGuardReadmeZh from "../pi-packages/mpi-stuck-guard/README.zh.md" with { type: "text" };
import stuckGuardIndex from "../pi-packages/mpi-stuck-guard/index.ts" with { type: "text" };
import stuckGuardSearchGuard from "../pi-packages/mpi-stuck-guard/search-guard.ts" with {
  type: "text",
};
import stuckGuardProviderWatchdog from "../pi-packages/mpi-stuck-guard/provider-watchdog.ts" with {
  type: "text",
};
import stuckGuardProviderWrapper from "../pi-packages/mpi-stuck-guard/provider-wrapper.ts" with {
  type: "text",
};
import stuckGuardConfig from "../pi-packages/mpi-stuck-guard/config.ts" with { type: "text" };
import stuckGuardConfigCommand from "../pi-packages/mpi-stuck-guard/config-command.ts" with {
  type: "text",
};
import stuckGuardConfigOverlay from "../pi-packages/mpi-stuck-guard/config-overlay.ts" with {
  type: "text",
};
import stuckGuardProviderPicker from "../pi-packages/mpi-stuck-guard/provider-picker.ts" with {
  type: "text",
};
import stuckGuardStats from "../pi-packages/mpi-stuck-guard/stats.ts" with { type: "text" };
import stuckGuardStatsOverlay from "../pi-packages/mpi-stuck-guard/stats-overlay.ts" with {
  type: "text",
};
import stuckGuardSchemaHint from "../pi-packages/mpi-stuck-guard/schema-hint.ts" with {
  type: "text",
};
import stuckGuardSchemaJson from "../pi-packages/mpi-stuck-guard/mpi-stuck-guard.schema.json" with {
  type: "text",
};
import stuckGuardPackageJson from "../pi-packages/mpi-stuck-guard/package.json" with {
  type: "text",
};
import mpiBatchIndex from "../pi-packages/mpi-batch-skill/index.ts" with { type: "text" };
import mpiBatchPackageJson from "../pi-packages/mpi-batch-skill/package.json" with { type: "text" };
import mpiBatchSkillMd from "../pi-packages/mpi-batch-skill/skills/mpi-batch/SKILL.md" with {
  type: "text",
};
import mpiBatchTsReference from "../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.ts" with {
  type: "text",
};
import mpiBatchLuaReference from "../pi-packages/mpi-batch-skill/skills/mpi-batch/references/mixcode-batch.d.lua" with {
  type: "text",
};
import mpiBatchReadmeMd from "../pi-packages/mpi-batch-skill/README.md" with { type: "text" };
import mpiBatchReadmeZhMd from "../pi-packages/mpi-batch-skill/README.zh.md" with { type: "text" };
import mpiGoal_index_ts from "../pi-packages/mpi-goal/index.ts" with { type: "text" };
import mpiGoal_package_json from "../pi-packages/mpi-goal/package.json" with { type: "text" };
import mpiGoal_src_app_ts from "../pi-packages/mpi-goal/src/app.ts" with { type: "text" };
import mpiGoal_src_shell_ts from "../pi-packages/mpi-goal/src/shell.ts" with { type: "text" };
import mpiGoal_src_session_gate_ts from "../pi-packages/mpi-goal/src/session-gate.ts" with {
  type: "text",
};
import mpiGoal_src_domain_active_time_ts from "../pi-packages/mpi-goal/src/domain/active-time.ts" with {
  type: "text",
};
import mpiGoal_src_domain_session_scope_ts from "../pi-packages/mpi-goal/src/domain/session-scope.ts" with {
  type: "text",
};
import mpiGoal_src_domain_budget_ts from "../pi-packages/mpi-goal/src/domain/budget.ts" with {
  type: "text",
};
import mpiGoal_src_domain_completion_gate_ts from "../pi-packages/mpi-goal/src/domain/completion-gate.ts" with {
  type: "text",
};
import mpiGoal_src_domain_constants_ts from "../pi-packages/mpi-goal/src/domain/constants.ts" with {
  type: "text",
};
import mpiGoal_src_domain_floor_steering_ts from "../pi-packages/mpi-goal/src/domain/floor-steering.ts" with {
  type: "text",
};
import mpiGoal_src_domain_floor_ts from "../pi-packages/mpi-goal/src/domain/floor.ts" with {
  type: "text",
};
import mpiGoal_src_domain_format_ts from "../pi-packages/mpi-goal/src/domain/format.ts" with {
  type: "text",
};
import mpiGoal_src_domain_goal_intent_ts from "../pi-packages/mpi-goal/src/domain/goal-intent.ts" with {
  type: "text",
};
import mpiGoal_src_domain_telemetry_ts from "../pi-packages/mpi-goal/src/domain/telemetry.ts" with {
  type: "text",
};
import mpiGoal_src_domain_types_ts from "../pi-packages/mpi-goal/src/domain/types.ts" with {
  type: "text",
};
import mpiGoal_src_persistence_goal_store_ts from "../pi-packages/mpi-goal/src/persistence/goal-store.ts" with {
  type: "text",
};
import mpiGoal_src_persistence_queue_store_ts from "../pi-packages/mpi-goal/src/persistence/queue-store.ts" with {
  type: "text",
};
import mpiGoal_src_queue_block_parser_ts from "../pi-packages/mpi-goal/src/queue/block-parser.ts" with {
  type: "text",
};
import mpiGoal_src_queue_steering_ts from "../pi-packages/mpi-goal/src/queue/steering.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_context_reset_ts from "../pi-packages/mpi-goal/src/runtime/context-reset.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_continuation_ticket_ts from "../pi-packages/mpi-goal/src/runtime/continuation-ticket.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_continuation_ts from "../pi-packages/mpi-goal/src/runtime/continuation.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_lifecycle_ts from "../pi-packages/mpi-goal/src/runtime/lifecycle.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_post_completion_ts from "../pi-packages/mpi-goal/src/runtime/post-completion.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_prompts_ts from "../pi-packages/mpi-goal/src/runtime/prompts.ts" with {
  type: "text",
};
import mpiGoal_src_runtime_terminal_workflow_ts from "../pi-packages/mpi-goal/src/runtime/terminal-workflow.ts" with {
  type: "text",
};
import mpiGoal_src_surface_command_register_ts from "../pi-packages/mpi-goal/src/surface/command/register.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_dynamic_ts from "../pi-packages/mpi-goal/src/surface/tools/dynamic.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_goal_tools_ts from "../pi-packages/mpi-goal/src/surface/tools/goal-tools.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_names_ts from "../pi-packages/mpi-goal/src/surface/tools/names.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_queue_tools_ts from "../pi-packages/mpi-goal/src/surface/tools/queue-tools.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_results_ts from "../pi-packages/mpi-goal/src/surface/tools/results.ts" with {
  type: "text",
};
import mpiGoal_src_surface_tools_schemas_ts from "../pi-packages/mpi-goal/src/surface/tools/schemas.ts" with {
  type: "text",
};
import mpiGoal_src_surface_ui_goal_overlay_ts from "../pi-packages/mpi-goal/src/surface/ui/goal-overlay.ts" with {
  type: "text",
};
import mpiGoal_src_surface_ui_notify_ts from "../pi-packages/mpi-goal/src/surface/ui/notify.ts" with {
  type: "text",
};
import mpiGoal_src_surface_ui_widget_ts from "../pi-packages/mpi-goal/src/surface/ui/widget.ts" with {
  type: "text",
};
import mpiGoal_src_templates_discover_ts from "../pi-packages/mpi-goal/src/templates/discover.ts" with {
  type: "text",
};
import promptHistoryIndex from "../pi-packages/mpi-prompt-history/index.ts" with { type: "text" };
import promptHistoryBrowser from "../pi-packages/mpi-prompt-history/prompt-history-browser.ts" with {
  type: "text",
};
import promptHistoryStore from "../pi-packages/mpi-prompt-history/history-store.ts" with {
  type: "text",
};
import promptHistoryPidLock from "../pi-packages/mpi-prompt-history/pid-lock.ts" with {
  type: "text",
};
import promptHistoryConfigUi from "../pi-packages/mpi-prompt-history/config-ui.ts" with {
  type: "text",
};
import promptHistorySchemaJson from "../pi-packages/mpi-prompt-history/mpi-prompt-history.schema.json" with {
  type: "text",
};
import promptHistoryPackageJson from "../pi-packages/mpi-prompt-history/package.json" with {
  type: "text",
};
import autoRenameIndex from "../pi-packages/mpi-auto-rename/index.ts" with { type: "text" };
import autoRenameConfig from "../pi-packages/mpi-auto-rename/config.ts" with { type: "text" };
import autoRenameConfigOverlay from "../pi-packages/mpi-auto-rename/config-overlay.ts" with {
  type: "text",
};
import autoRenamePackageJson from "../pi-packages/mpi-auto-rename/package.json" with {
  type: "text",
};
import autoRenameSchemaJson from "../pi-packages/mpi-auto-rename/mpi-auto-rename.schema.json" with {
  type: "text",
};
import optimizePromptIndex from "../pi-packages/mpi-optimize-prompt/index.ts" with { type: "text" };
import optimizePromptCore from "../pi-packages/mpi-optimize-prompt/core.ts" with { type: "text" };
import optimizePromptConfig from "../pi-packages/mpi-optimize-prompt/config.ts" with {
  type: "text",
};
import optimizePromptConfigOverlay from "../pi-packages/mpi-optimize-prompt/config-overlay.ts" with {
  type: "text",
};
import optimizePromptPackageJson from "../pi-packages/mpi-optimize-prompt/package.json" with {
  type: "text",
};
import optimizePromptSchemaJson from "../pi-packages/mpi-optimize-prompt/mpi-optimize-prompt.schema.json" with {
  type: "text",
};
import modelAttachIndex from "../pi-packages/mpi-model-attach/index.ts" with { type: "text" };
import modelAttachCore from "../pi-packages/mpi-model-attach/model-attach-core.ts" with {
  type: "text",
};
import modelAttachLoader from "../pi-packages/mpi-model-attach/model-attach-loader.ts" with {
  type: "text",
};
import modelAttachPackageJson from "../pi-packages/mpi-model-attach/package.json" with {
  type: "text",
};
import modelAttachSchemaJson from "../pi-packages/mpi-model-attach/mpi-model-attach.schema.json" with {
  type: "text",
};
import permissionIndex from "../pi-packages/mpi-permission/index.ts" with { type: "text" };
import permissionCore from "../pi-packages/mpi-permission/permission-core.ts" with { type: "text" };
import permissionBashPolicy from "../pi-packages/mpi-permission/bash-policy.ts" with {
  type: "text",
};
import permissionOverlay from "../pi-packages/mpi-permission/permission-overlay.ts" with {
  type: "text",
};
import permissionPackageJson from "../pi-packages/mpi-permission/package.json" with {
  type: "text",
};
import permissionSchemaJson from "../pi-packages/mpi-permission/mpi-permission.schema.json" with {
  type: "text",
};
import permissionUnbashJs from "../pi-packages/mpi-permission/vendor/unbash.js" with {
  type: "text",
};
import permissionUnbashDts from "../pi-packages/mpi-permission/vendor/unbash.d.ts" with {
  type: "text",
};
import permissionUnbashTypesDts from "../pi-packages/mpi-permission/vendor/unbash-types.d.ts" with {
  type: "text",
};
import permissionUnbashLicense from "../pi-packages/mpi-permission/vendor/UNBASH-LICENSE" with {
  type: "text",
};
import permissionUnbashNotice from "../pi-packages/mpi-permission/vendor/UNBASH-NOTICE" with {
  type: "text",
};
import permissionSkillMd from "../pi-packages/mpi-permission/skills/mpi-permission/SKILL.md" with {
  type: "text",
};
import permissionReadmeMd from "../pi-packages/mpi-permission/README.md" with { type: "text" };
import permissionReadmeZhMd from "../pi-packages/mpi-permission/README.zh.md" with { type: "text" };
import toolBlockIndex from "../pi-packages/mpi-tool-block/index.ts" with { type: "text" };
import toolBlockCore from "../pi-packages/mpi-tool-block/tool-block-core.ts" with { type: "text" };
import toolBlockOverlay from "../pi-packages/mpi-tool-block/tool-block-overlay.ts" with {
  type: "text",
};
import toolBlockPackageJson from "../pi-packages/mpi-tool-block/package.json" with { type: "text" };
import toolBlockSchemaJson from "../pi-packages/mpi-tool-block/mpi-tool-block.schema.json" with {
  type: "text",
};
import toolBlockSkillMd from "../pi-packages/mpi-tool-block/skills/mpi-tool-block/SKILL.md" with {
  type: "text",
};
import workingTimerIndex from "../pi-packages/mpi-working-timer/index.ts" with { type: "text" };
import workingTimerPackageJson from "../pi-packages/mpi-working-timer/package.json" with {
  type: "text",
};
import packageJson from "../vendor/pi/packages/coding-agent/package.json" with { type: "json" };
import packageReadme from "../vendor/pi/packages/coding-agent/README.md" with { type: "text" };
import packageChangelog from "../vendor/pi/packages/coding-agent/CHANGELOG.md" with {
  type: "text",
};
import { codingAgentDocs, forkDocs } from "./fork-docs.generated.js";
import { forkExamples } from "./fork-examples.generated.js";
import { installMixcodeDocs, materializeBinaryRuntimeAssets } from "./fork-binary-assets.js";
import { ensurePackageExtensions } from "./ensure-package-extensions.js";

// Keep large extracted assets in the user cache on Linux, not the shared system tmp.
const xdgCacheHome = process.env.XDG_CACHE_HOME;
const runtimeBase =
  process.platform === "linux"
    ? path.join(
        xdgCacheHome && path.isAbsolute(xdgCacheHome)
          ? xdgCacheHome
          : path.join(os.homedir(), ".cache"),
        "mpi",
        "tmp",
      )
    : os.tmpdir();
if (process.platform === "linux") fs.mkdirSync(runtimeBase, { recursive: true, mode: 0o700 });

// Sync mkdtemp/rm for process-exit cleanup (no async allowed on exit handlers).
const runtimeDir = fs.mkdtempSync(path.join(runtimeBase, "mixcode-pi-"));

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
  auroraTheme,
  darkTheme,
  lightTheme,
  exportTemplateCss,
  exportTemplateHtml,
  exportTemplateJs,
  exportVendorMarked,
  exportVendorMarkedCjk,
  exportVendorHighlight,
  interactiveAssets: { "clankolas.png": clankolasImagePath },
  photonWasmPath,
  nativePlatformHelpers: {
    "darwin/prebuilds/darwin-arm64/darwin-platform.node": darwinArm64Helper,
    "darwin/prebuilds/darwin-x64/darwin-platform.node": darwinX64Helper,
    "linux/prebuilds/linux-arm64/linux-platform-x11.node": linuxArm64Helper,
    "linux/prebuilds/linux-x64/linux-platform-x11.node": linuxX64Helper,
    "win32/prebuilds/win32-arm64/win32-platform.node": win32Arm64Helper,
    "win32/prebuilds/win32-x64/win32-platform.node": win32X64Helper,
  },
  packageJson,
  packageReadme,
  packageChangelog,
  forkDocs,
  codingAgentDocs,
  forkExamples,
  builtinPackages: {
    "mpi-diff-viewer": {
      "index.ts": diffViewerIndex,
      "session-diff.ts": diffViewerSessionDiff,
      "diff-viewer.ts": diffViewerComponent,
      "review.ts": diffViewerReview,
      "package.json": diffViewerPackageJson,
    },
    "mpi-transcript": {
      "index.ts": transcriptIndex,
      "cache-miss.ts": transcriptCacheMiss,
      "config.ts": transcriptConfig,
      "editor.ts": transcriptEditor,
      "config-overlay.ts": transcriptConfigOverlay,
      "mpi-transcript.schema.json": transcriptSchemaJson,
      "package.json": transcriptPackageJson,
    },
    "mpi-command-router": {
      "index.ts": commandRouterIndex,
      "config.ts": commandRouterConfig,
      "router.ts": commandRouterRouter,
      "mpi-command-router.schema.json": commandRouterSchema,
      "skills/mpi-command-router/SKILL.md": commandRouterSkill,
      "package.json": commandRouterPackageJson,
      "README.md": commandRouterReadme,
      "README.zh.md": commandRouterReadmeZh,
    },
    "mpi-bash": {
      "index.ts": bashIndex,
      "exec.ts": bashExec,
      "widget.ts": bashWidget,
      "bash-logs.ts": bashLogs,
      "log-view.ts": bashLogView,
      "heartbeat.ts": bashHeartbeat,
      "tool-display-config.ts": bashToolDisplayConfig,
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
    "mpi-cron": {
      "index.ts": cronIndex,
      "cron-engine.ts": cronCronEngine,
      "storage.ts": cronStorage,
      "hub.ts": cronHub,
      "types.ts": cronTypes,
      "tool.ts": cronTool,
      "cron-widget.ts": cronCronWidget,
      "cron-management-view.ts": cronCronManagementView,
      "package.json": cronPackageJson,
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
      "README.md": skillRefsReadme,
      "README.zh.md": skillRefsReadmeZh,
    },
    "mpi-stuck-guard": {
      "index.ts": stuckGuardIndex,
      "doom-loop.ts": stuckGuardDoomLoop,
      "read-progress.ts": stuckGuardReadProgress,
      "cycle-detection.ts": stuckGuardCycleDetection,
      "README.md": stuckGuardReadme,
      "README.zh.md": stuckGuardReadmeZh,
      "search-guard.ts": stuckGuardSearchGuard,
      "provider-watchdog.ts": stuckGuardProviderWatchdog,
      "provider-wrapper.ts": stuckGuardProviderWrapper,
      "config.ts": stuckGuardConfig,
      "config-command.ts": stuckGuardConfigCommand,
      "config-overlay.ts": stuckGuardConfigOverlay,
      "provider-picker.ts": stuckGuardProviderPicker,
      "stats.ts": stuckGuardStats,
      "stats-overlay.ts": stuckGuardStatsOverlay,
      "mpi-stuck-guard.schema.json": stuckGuardSchemaJson,
      "schema-hint.ts": stuckGuardSchemaHint,
      "package.json": stuckGuardPackageJson,
    },
    "mpi-batch-skill": {
      "index.ts": mpiBatchIndex,
      "package.json": mpiBatchPackageJson,
      "skills/mpi-batch/SKILL.md": mpiBatchSkillMd,
      "skills/mpi-batch/references/mixcode-batch.d.ts": mpiBatchTsReference,
      "skills/mpi-batch/references/mixcode-batch.d.lua": mpiBatchLuaReference,
      "README.md": mpiBatchReadmeMd,
      "README.zh.md": mpiBatchReadmeZhMd,
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
      "README.md": permissionReadmeMd,
      "README.zh.md": permissionReadmeZhMd,
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
    "mpi-model-attach": {
      "index.ts": modelAttachIndex,
      "model-attach-core.ts": modelAttachCore,
      "model-attach-loader.ts": modelAttachLoader,
      "package.json": modelAttachPackageJson,
      "mpi-model-attach.schema.json": modelAttachSchemaJson,
    },
    "mpi-tool-block": {
      "index.ts": toolBlockIndex,
      "tool-block-core.ts": toolBlockCore,
      "tool-block-overlay.ts": toolBlockOverlay,
      "package.json": toolBlockPackageJson,
      "mpi-tool-block.schema.json": toolBlockSchemaJson,
      "skills/mpi-tool-block/SKILL.md": toolBlockSkillMd,
    },
    "mpi-working-timer": {
      "index.ts": workingTimerIndex,
      "package.json": workingTimerPackageJson,
    },
  },
});

process.env.PI_PACKAGE_DIR = runtimeDir;
const { getAgentDir } = await import("../vendor/pi/packages/coding-agent/src/config.ts");
const agentDir = getAgentDir();
await installMixcodeDocs(agentDir, forkDocs);

ensurePackageExtensions(runtimeDir, { agentDir });
await import("../vendor/pi/packages/coding-agent/dist/bun/cli.js");
