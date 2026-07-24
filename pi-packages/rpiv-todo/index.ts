/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 *
 * MixCode local modification: todo state and the overlay are namespaced by
 * session id so multiple tabs keep independent lists. See NOTICE.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, resolveCollapseKey } from "./config.js";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { sessionIdFromCtx } from "./state/session.js";
import { disposeSession, replaceState } from "./state/store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	// Indirect the specifier so TypeScript treats this as a non-analyzable
	// dynamic import: `@juicesharp/rpiv-i18n` is an optional peer that is not
	// installed in this tree, and the try/catch below is the runtime contract
	// for its absence (English-only fallback).
	const i18nLoaderSpecifier = "@juicesharp/rpiv-i18n/loader";
	const sdk = (await import(i18nLoaderSpecifier)) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// One overlay per session id. Upstream kept a single overlay instance; in
	// MixCode the extension module is shared across tabs, so a single overlay
	// would render whichever session's state was last written. Keyed by session
	// id, each tab drives its own widget. Entries are removed on shutdown.
	const overlays = new Map<string, TodoOverlay>();

	registerTodoTool(pi);
	registerTodosCommand(pi);

	const overlayFor = (sessionId: string, uiCtx: Parameters<TodoOverlay["setUICtx"]>[0]): TodoOverlay => {
		let overlay = overlays.get(sessionId);
		if (!overlay) {
			overlay = new TodoOverlay(sessionId);
			overlays.set(sessionId, overlay);
		}
		overlay.setUICtx(uiCtx);
		return overlay;
	};

	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
			handler: (ctx) => {
				if (!ctx.hasUI) return;
				const overlay = overlays.get(sessionIdFromCtx(ctx));
				if (overlay?.isRegistered()) overlay.toggleCollapse();
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = sessionIdFromCtx(ctx);
		replaceState(sessionId, replayFromBranch(ctx));
		if (ctx.hasUI) {
			const overlay = overlayFor(sessionId, ctx.ui);
			overlay.resetCompletedDisplayState();
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate.
		//
		// Resolve the session id before the try so a stale-ctx read of the id
		// itself is treated the same as a stale-ctx branch read: skip silently.
		let sessionId: string;
		try {
			sessionId = sessionIdFromCtx(ctx);
			replaceState(sessionId, replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		const overlay = overlays.get(sessionId);
		overlay?.resetCompletedDisplayState();
		overlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		let sessionId: string;
		try {
			sessionId = sessionIdFromCtx(ctx);
			replaceState(sessionId, replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		const overlay = overlays.get(sessionId);
		overlay?.resetCompletedDisplayState();
		overlay?.update();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = sessionIdFromCtx(ctx);
		overlays.get(sessionId)?.dispose();
		overlays.delete(sessionId);
		disposeSession(sessionId);
	});

	// Reads the session's state at render time; do NOT call replayFromBranch
	// here (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		overlays.get(sessionIdFromCtx(ctx))?.update();
	});

	pi.on("agent_start", async (_event, ctx) => {
		overlays.get(sessionIdFromCtx(ctx))?.hideCompletedTasksFromPreviousTurn();
	});
}
