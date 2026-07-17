export const STATE_ENTRY_TYPE = "mpi-goal-state";
export const CONTINUATION_MESSAGE_TYPE = "mpi-goal-continuation";
export const BUDGET_LIMIT_MESSAGE_TYPE = "mpi-goal-budget-limit";
export const PAUSE_MESSAGE_TYPE = "mpi-goal-pause";
export const QUEUE_MESSAGE_TYPE = "mpi-goal-queue-steer";

export const MAX_OBJECTIVE_CHARS = 100000;
export const LONG_OBJECTIVE_HINT =
  "Put longer instructions in a file and refer to that file in the goal, for example: /goal follow the instructions in docs/goal.md.";

export const STATUS_UI_KEY = "mpi-goal";
export const WIDGET_UI_KEY = "mpi-goal";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const STATE_EVENT_VERSION = 1 as const;

export const MAX_CONSECUTIVE_AUTO_TURNS = 50;
export const MAX_NO_PROGRESS_AUTO_TURNS = 3;
export const OBJECTIVE_EXCERPT_CHARS = 96;
export const TOKEN_BUDGET_WARNING_REMAINING = 100_000;
export const TIME_BUDGET_WARNING_REMAINING_SECONDS = 60;
export const BUDGET_HARD_STOP_MULTIPLIER = 1.1;


export const AGENT_END_HANDOFF_DELAY_MS = 50;

export const CONTINUATION_PROMPT_ID = "mpi-goal-continuation-v1";
export const BUDGET_LIMIT_PROMPT_ID = "mpi-goal-budget-limit-v1";
export const BUDGET_WARNING_PROMPT_ID = "mpi-goal-budget-warning-v1";
export const PAUSE_PROMPT_ID = "mpi-goal-pause-v1";
export const QUEUE_PROMPT_ID = "mpi-goal-queue-v1";

export const GOAL_USAGE = "Usage: /goal [<objective>|pause|resume|clear|queue|tools]";
export const GOAL_USAGE_HINT =
	"Examples: /goal ship the release · /goal tools activates all goal model tools · /goal queue <later work>.";
