/**
 * Session-id resolution helper.
 *
 * Every store read/write is namespaced by session id so each MixCode tab keeps
 * an independent todo list (see state/store.ts). Tool execution and command
 * handlers both receive a context exposing `sessionManager.getSessionId()`;
 * lifecycle events (session_start / session_compact / session_tree) expose the
 * same. This module centralises pulling the id out so call sites stay terse and
 * a single place handles the (defensive) missing-manager shape.
 */

type SessionCtx = {
	sessionManager?: { getSessionId?: () => string | undefined };
};

// ponytail: single fallback key for contexts without a resolvable session id.
// In normal operation every event/tool/command ctx carries a sessionManager,
// so this is only hit by malformed test doubles or future SDK shape drift.
const FALLBACK_SESSION_ID = "__rpiv_todo_default__";

export function sessionIdFromCtx(ctx: SessionCtx): string {
	return ctx.sessionManager?.getSessionId?.() ?? FALLBACK_SESSION_ID;
}
