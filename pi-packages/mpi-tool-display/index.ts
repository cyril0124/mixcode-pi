// ╔══════════════════════════════════════════════════════════════════════╗
// ║  mpi-tool-display: render-only bash/read/edit/write + Thinking UI      ║
// ╠══════════════════════════════════════════════════════════════════════╣
// ║  ToolExecutionComponent selects the compact display profile: ║
// ║    bash  `$ command`, spinner, `↳ N lines returned`, live preview      ║
// ║    read  `read path[:range]`, `↳ loaded N lines`                      ║
// ║    edit  pending preview + bars / split / wrap result diff             ║
// ║    write pending preview + pre-captured overwrite diff                 ║
// ║                                                                        ║
// ║  Tool definitions are never registered, replaced, or execute-wrapped. ║
// ║  Native ownership, cwd, settings, and PI_* session env stay intact.    ║
// ║  Optional global debugging appends raw JSON arguments after calls.     ║
// ║  tool_call captures prior write content only for diff presentation.    ║
// ╚══════════════════════════════════════════════════════════════════════╝

import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	EditToolDetails,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	formatSize,
	getAgentDir,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { renderBashCall } from "./bash-display.js";
import {
	loadToolDisplayRuntimeConfig,
	type ToolDisplayRuntimeConfig,
	writeToolDisplayRuntimeConfig,
} from "./config.js";
import { createToolDisplayConfigOverlay } from "./config-overlay.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import {
	buildPendingEditPreviewData,
	buildPendingWritePreviewData,
	type PendingDiffPreviewData,
	readWorkspaceUtf8File,
} from "./pending-diff-preview.js";
import { registerThinkingLabeling } from "./thinking-label.js";
import { wrapToolCallRenderer } from "./tool-call-renderer.js";
import {
	installToolExecutionAdapter,
	type CallRenderer,
	type RenderShell,
	type ResultRenderer,
} from "./tool-execution-adapter.js";
import {
	buildEditCallSummaryText,
	buildWriteCallSummaryText,
	countWriteContentLines,
	getEditLineCount,
	getStringField,
	getToolContentArg,
	getToolPathArg,
	handleEditOrWriteResult,
	renderBashDisplayResult,
	renderReadDisplayCall,
	renderReadDisplayResult,
	textResult,
} from "./tool-summaries.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./types.js";

/** Frozen display knobs. Values define the fixed package display profile. */
const CONFIG: ToolDisplayConfig = DEFAULT_TOOL_DISPLAY_CONFIG;
const CONFIG_SUBCOMMAND = "config";
/** Bound for the write previous-content cache; entries drain on render. */
const WRITE_EXECUTION_META_LIMIT = 64;

type RenderTheme = Parameters<NonNullable<ToolDefinition["renderResult"]>>[2];
type RenderResultOptions = Parameters<NonNullable<ToolDefinition["renderResult"]>>[1];
/** Structural subset of Pi's ToolRenderContext consumed by this package. */
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

export interface WriteExecutionMeta {
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
}

interface PendingDiffPreviewState {
	key?: string;
	data?: PendingDiffPreviewData;
}

const EDIT_PENDING_PREVIEW_STATE_KEY = "mpiToolDisplayEditPendingPreview";
const WRITE_PENDING_PREVIEW_STATE_KEY = "mpiToolDisplayWritePendingPreview";
const WRITE_EXECUTION_META_STATE_KEY = "mpiToolDisplayWriteExecutionMeta";

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function resolvePendingDiffPreview(
	context: ToolRenderContext | undefined,
	stateKey: string,
	previewKey: string,
	compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
	const carrier =
		context?.state && typeof context.state === "object"
			? (context.state as Record<string, unknown>)
			: undefined;
	if (!carrier) return compute();
	const current = carrier[stateKey];
	const state: PendingDiffPreviewState =
		current && typeof current === "object" ? (current as PendingDiffPreviewState) : {};
	carrier[stateKey] = state;
	if (state.key !== previewKey) {
		state.key = previewKey;
		state.data = compute();
	}
	return state.data;
}

function buildPendingDiffCallComponent(
	summary: Component,
	previewData: PendingDiffPreviewData | undefined,
	context: ToolRenderContext,
	theme: RenderTheme,
): Component {
	if (!context.isPartial || !previewData) return summary;
	const container = new Container();
	container.addChild(summary);
	container.addChild(new Spacer(1));
	if (previewData.notice || typeof previewData.nextContent !== "string") {
		container.addChild(
			new Text(theme.fg("warning", previewData.notice || "Preview unavailable."), 0, 0),
		);
		return container;
	}
	container.addChild(
		renderWriteDiffResult(
			previewData.nextContent,
			{
				expanded: context.expanded === true,
				filePath: previewData.filePath,
				previousContent: previewData.previousContent,
				fileExistedBeforeWrite: previewData.fileExistedBeforeWrite,
				headerLabel: previewData.headerLabel,
			},
			CONFIG,
			theme,
			"",
		),
	);
	return container;
}

function recordWriteExecutionMeta(
	metaByToolCallId: Map<string, WriteExecutionMeta>,
	toolCallId: string,
	meta: WriteExecutionMeta,
): void {
	metaByToolCallId.delete(toolCallId);
	metaByToolCallId.set(toolCallId, meta);
	while (metaByToolCallId.size > WRITE_EXECUTION_META_LIMIT) {
		const oldest = metaByToolCallId.keys().next().value as string | undefined;
		if (oldest === undefined) return;
		metaByToolCallId.delete(oldest);
	}
}

function getWriteExecutionMeta(
	context: ToolRenderContext | undefined,
	metaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
	if (!context) return undefined;
	const carrier =
		context.state && typeof context.state === "object"
			? (context.state as Record<string, unknown>)
			: undefined;
	const stored = carrier ? carrier[WRITE_EXECUTION_META_STATE_KEY] : undefined;
	if (stored && typeof stored === "object") return stored as WriteExecutionMeta;
	const pending = context.toolCallId ? metaByToolCallId.get(context.toolCallId) : undefined;
	if (!pending) return undefined;
	if (carrier) {
		carrier[WRITE_EXECUTION_META_STATE_KEY] = { ...pending };
		metaByToolCallId.delete(context.toolCallId);
	}
	return pending;
}

export interface ToolDisplayRenderer {
	renderCall: CallRenderer;
	renderResult: ResultRenderer;
}

export interface ToolDisplayRendererCatalog {
	bash: ToolDisplayRenderer;
	read: ToolDisplayRenderer;
	edit: ToolDisplayRenderer;
	write: ToolDisplayRenderer;
}

function captureWritePreviousContent(
	metaByToolCallId: Map<string, WriteExecutionMeta>,
	toolCallId: string,
	cwd: string,
	input: unknown,
): void {
	const rawPath = getStringField(input, "path");
	if (!rawPath?.trim()) return;
	const existing = readWorkspaceUtf8File(cwd, rawPath);
	recordWriteExecutionMeta(metaByToolCallId, toolCallId, {
		fileExistedBeforeWrite: existing.exists,
		previousContent: existing.content,
	});
}

export function createToolDisplayRenderers(
	writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>(),
): ToolDisplayRendererCatalog {
	const bash: ToolDisplayRenderer = {
		renderCall: (args, theme, context) =>
			renderBashCall(args as never, theme, context as never),
		renderResult: (result, options, theme, context) =>
			renderBashDisplayResult(result as never, options, CONFIG, theme, context),
	};
	const read: ToolDisplayRenderer = {
		renderCall: (args, theme) => renderReadDisplayCall(args, theme),
		renderResult: (result, options, theme) =>
			renderReadDisplayResult(result as never, options, CONFIG, theme),
	};
	const edit: ToolDisplayRenderer = {
		renderCall: (args, theme, context) => {
			const summary = textResult(buildEditCallSummaryText(args, theme));
			if (!context?.argsComplete || !context.isPartial) return summary;
			const previewKey = JSON.stringify({
				path: getToolPathArg(args) ?? null,
				edits: toRecord(args).edits ?? null,
				oldText: getStringField(args, "oldText") ?? null,
				newText: getStringField(args, "newText") ?? null,
			});
			const previewData = resolvePendingDiffPreview(
				context,
				EDIT_PENDING_PREVIEW_STATE_KEY,
				previewKey,
				() => buildPendingEditPreviewData(args, context.cwd),
			);
			return buildPendingDiffCallComponent(summary, previewData, context, theme);
		},
		renderResult: (result, options, theme, context) => {
			const lineCount = getEditLineCount(context?.args);
			const { fallbackText, earlyResult } = handleEditOrWriteResult(
				result as never,
				options,
				context,
				theme,
				lineCount,
				"editing",
				"Edit failed.",
			);
			if (earlyResult) return earlyResult;
			return renderEditDiffResult(
				result.details as EditToolDetails | undefined,
				{ expanded: options.expanded, filePath: getToolPathArg(context?.args) },
				CONFIG,
				theme,
				fallbackText,
			);
		},
	};
	const write: ToolDisplayRenderer = {
		renderCall: (args, theme, context) => {
			const summary = textResult(buildWriteCallSummaryText(args, theme, formatSize));
			if (!context?.argsComplete || !context.isPartial) return summary;
			const previewKey = JSON.stringify({
				path: getToolPathArg(args) ?? null,
				content: getToolContentArg(args) ?? null,
			});
			const previewData = resolvePendingDiffPreview(
				context,
				WRITE_PENDING_PREVIEW_STATE_KEY,
				previewKey,
				() => buildPendingWritePreviewData(args, context.cwd),
			);
			return buildPendingDiffCallComponent(summary, previewData, context, theme);
		},
		renderResult: (result, options, theme, context) => {
			const content = getToolContentArg(context?.args);
			const lineCount = countWriteContentLines(content);
			const { fallbackText, earlyResult } = handleEditOrWriteResult(
				result as never,
				options,
				context,
				theme,
				lineCount,
				"writing",
				"Write failed.",
			);
			if (earlyResult) return earlyResult;
			const meta = getWriteExecutionMeta(context, writeExecutionMetaByToolCallId);
			return renderWriteDiffResult(
				content,
				{
					expanded: options.expanded,
					filePath: getToolPathArg(context?.args),
					previousContent: meta?.previousContent,
					fileExistedBeforeWrite: meta?.fileExistedBeforeWrite ?? false,
				},
				CONFIG,
				theme,
				fallbackText,
			);
		},
	};
	return { bash, read, edit, write };
}

function rendererFor(
	catalog: ToolDisplayRendererCatalog,
	toolName: string,
): ToolDisplayRenderer | undefined {
	switch (toolName) {
		case "bash":
			return catalog.bash;
		case "read":
			return catalog.read;
		case "edit":
			return catalog.edit;
		case "write":
			return catalog.write;
		default:
			return undefined;
	}
}

function loadRuntimeConfigOrThrow(agentDir: string): ToolDisplayRuntimeConfig {
	const loaded = loadToolDisplayRuntimeConfig(agentDir);
	if (!loaded.ok) {
		throw new Error(`mpi-tool-display config error (${loaded.path}): ${loaded.error}`);
	}
	return loaded.config;
}

async function openToolDisplayConfig(
	ctx: ExtensionCommandContext,
	agentDir: string,
	apply: (config: ToolDisplayRuntimeConfig) => void,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("mpi-tool-display config requires interactive UI", "error");
		return;
	}
	const loaded = loadToolDisplayRuntimeConfig(agentDir);
	if (!loaded.ok) {
		ctx.ui.notify(`mpi-tool-display config error (${loaded.path}): ${loaded.error}`, "error");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			createToolDisplayConfigOverlay({
				theme,
				requestRender: () => tui.requestRender(),
				done: () => done(undefined),
				configPath: loaded.path,
				initial: loaded.config,
				persist: (next) => {
					const written = writeToolDisplayRuntimeConfig(agentDir, next);
					if (!written.ok) {
						return {
							ok: false,
							error: `Failed to write ${written.path}: ${written.error}`,
						};
					}
					apply(written.config);
					return { ok: true, config: written.config };
				},
				onError: (message) => ctx.ui.notify(message, "error"),
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "72%",
				maxHeight: "80%",
				margin: 1,
			},
		},
	);
}

export default function toolDisplayExtension(pi: ExtensionAPI): void {
	// Initialize cleanup at extension activation because MixCode may load after session_start
	// registry immediately. MixCode can load an extension after session_start.
	resetDisposed();
	const agentDir = getAgentDir();
	let runtimeConfig = loadRuntimeConfigOrThrow(agentDir);
	const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();
	const catalog = createToolDisplayRenderers(writeExecutionMetaByToolCallId);
	const installation = installToolExecutionAdapter(ToolExecutionComponent.prototype, {
		call: (toolName, native) =>
			wrapToolCallRenderer(
				toolName,
				rendererFor(catalog, toolName)?.renderCall ?? native,
				runtimeConfig.showRawToolArguments,
			),
		result: (toolName, native) => rendererFor(catalog, toolName)?.renderResult ?? native,
		shell: (toolName, native): RenderShell => (toolName === "edit" ? "default" : native),
		showRawArguments: () => runtimeConfig.showRawToolArguments,
	});

	const applyRuntimeConfig = (next: ToolDisplayRuntimeConfig): void => {
		runtimeConfig = next;
	};
	const refreshRuntimeConfig = (ctx: ExtensionContext): void => {
		const loaded = loadToolDisplayRuntimeConfig(agentDir);
		if (!loaded.ok) {
			ctx.ui.notify(`mpi-tool-display config error (${loaded.path}): ${loaded.error}`, "error");
			return;
		}
		applyRuntimeConfig(loaded.config);
	};

	pi.registerCommand("mpi-tool-display", {
		description: "[global] Configure tool call rendering; config opens settings",
		getArgumentCompletions: (prefix) => {
			const option = {
				value: CONFIG_SUBCOMMAND,
				label: CONFIG_SUBCOMMAND,
				description: "Open tool display settings",
			};
			return option.value.startsWith(prefix) ? [option] : null;
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase();
			if (subcommand !== CONFIG_SUBCOMMAND) {
				ctx.ui.notify("Usage: /mpi-tool-display config", "error");
				return;
			}
			await openToolDisplayConfig(ctx, agentDir, applyRuntimeConfig);
		},
	});

	pi.on("session_start", (_event, ctx) => refreshRuntimeConfig(ctx));
	pi.on("before_agent_start", (_event, ctx) => refreshRuntimeConfig(ctx));
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "write") {
			captureWritePreviousContent(
				writeExecutionMetaByToolCallId,
				event.toolCallId,
				ctx.cwd,
				event.input,
			);
		}
	});
	pi.on("session_shutdown", (event) => {
		writeExecutionMetaByToolCallId.clear();
		if (event.reason === "reload") disposeAll();
	});
	onReloadShutdown(pi, () => installation.dispose());
	registerThinkingLabeling(pi);
}
