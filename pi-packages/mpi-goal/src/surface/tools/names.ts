/** Goal/queue/template tools registered by mpi-goal. Kept inactive until /goal enables them. */
export const GOAL_TOOL_NAMES = [
  "get_goal",
  "list_goal_templates",
  "create_goal",
  "create_goal_from_template",
  "update_goal",
  "clear_goal",
  "list_goal_queue",
  "enqueue_goal",
  "start_queued_goal",
  "dequeue_goal",
  "remove_queued_goal",
] as const;

export const GOAL_TOOL_NAME_SET = new Set<string>(GOAL_TOOL_NAMES);

export const GOAL_TOOL_NAMESPACE = {
  name: "goal",
  description: "Persistent session goals, reusable templates, and queued objectives.",
  instructions:
    "Use goal tools only for explicit goal management. Query tools inspect state without changing it; creation, continuation, and queue changes must follow the user's request and the tool-specific guidelines.",
} as const;

export const GOAL_QUERY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const GOAL_ADDITIVE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export const GOAL_DESTRUCTIVE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export const GOAL_TEMPLATE_CAPABLE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;
