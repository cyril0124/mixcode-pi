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

export type GoalToolName = (typeof GOAL_TOOL_NAMES)[number];

export const GOAL_TOOL_NAME_SET = new Set<string>(GOAL_TOOL_NAMES);
