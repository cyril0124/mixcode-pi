import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_STUCK_GUARD_CONFIG, type StuckGuardConfigLoad } from "./config.js";

const MAX_DEPTH = 2;
const MAX_LINES = 15;
// pi-ai's validateToolArguments throws with this prefix; it is the only
// observable discriminator for parameter-validation failures (version-coupled).
const VALIDATION_ERROR_PREFIX = 'Validation failed for tool "';

/** Render a JSON-schema node as a compact type signature. */
function schemaType(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum.map(String).join("|");
  if (Array.isArray(s.anyOf)) return s.anyOf.map(schemaType).join("|");
  if (s.type === "array") {
    const item = s.items && typeof s.items === "object" ? s.items : undefined;
    const itemType =
      item && (item as Record<string, unknown>).type === "object"
        ? "object"
        : item
          ? schemaType(item)
          : "any";
    return `array<${itemType}>`;
  }
  return String(s.type ?? "unknown");
}

/**
 * Distill a tool's JSON parameter schema into a compact contract.
 * Depth- and line-capped: the full schema is already in the model's context,
 * this digest exists to refocus attention, not to replace it.
 */
export function distillToolSchema(toolName: string, parameters: unknown): string {
  const schema =
    parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : {};
  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [],
  );
  const lines: string[] = [];
  (function walk(
    props: unknown,
    required: ReadonlySet<string>,
    prefix: string,
    depth: number,
  ): void {
    if (!props || typeof props !== "object") return;
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      if (lines.length >= MAX_LINES) return;
      const label = prefix ? `${prefix}.${name}` : name;
      lines.push(`${label}: ${schemaType(sub)}${required.has(name) ? "" : " (optional)"}`);
      // Drill one concept level into objects / array<object>: field names are
      // what the model needs; deeper structure lives in the full schema.
      const child = (sub as Record<string, unknown> | undefined)?.items ?? sub;
      const childRecord =
        child && typeof child === "object" ? (child as Record<string, unknown>) : undefined;
      if (
        depth < MAX_DEPTH - 1 &&
        childRecord?.type === "object" &&
        childRecord.properties &&
        lines.length < MAX_LINES
      ) {
        walk(
          childRecord.properties,
          new Set<string>(
            Array.isArray(childRecord.required)
              ? (childRecord.required as unknown[]).map(String)
              : [],
          ),
          label,
          depth + 1,
        );
      }
    }
  })(schema.properties, required, "", 0);
  return `[${toolName} parameter contract]\n${lines.join("\n")}`;
}

interface ToolFailureState {
  consecutive: number;
  hinted: boolean;
}

/**
 * Detect repeated parameter-validation failures per tool and steer the model
 * with the distilled parameter contract. Listens on `tool_execution_end`
 * because validation failures skip the `tool_result` extension event.
 * The failure threshold comes from the shared stuck-guard config and is
 * reloaded on session_start / before_agent_start, matching the watchdog.
 */
export function wireSchemaHint(pi: ExtensionAPI, loadConfig: () => StuckGuardConfigLoad): void {
  const failures = new Map<string, ToolFailureState>();
  let threshold = DEFAULT_STUCK_GUARD_CONFIG.schemaHintFailureThreshold;

  function reload(): void {
    const loaded = loadConfig();
    threshold = loaded.ok
      ? loaded.config.schemaHintFailureThreshold
      : DEFAULT_STUCK_GUARD_CONFIG.schemaHintFailureThreshold;
  }

  reload();

  pi.on("session_start", () => {
    failures.clear();
    reload();
  });

  pi.on("before_agent_start", () => {
    reload();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const { toolName, isError } = event as { toolName: string; isError: boolean };
    const result = event.result as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    const isValidationError = isError && text.startsWith(VALIDATION_ERROR_PREFIX);

    const state = failures.get(toolName) ?? { consecutive: 0, hinted: false };
    if (!isValidationError) {
      // Any successful (or non-validation) call to the tool resets the streak.
      failures.set(toolName, { consecutive: 0, hinted: false });
      return;
    }
    state.consecutive += 1;
    if (state.consecutive < threshold || state.hinted) {
      failures.set(toolName, state);
      return;
    }
    state.hinted = true;
    failures.set(toolName, state);

    const tool = pi.getAllTools().find((t) => t.name === toolName);
    if (!tool) return;
    pi.sendMessage(
      {
        customType: "stuck-guard-schema-hint",
        content:
          `Tool "${toolName}" failed parameter validation ${state.consecutive} times in a row. ` +
          `Re-issue the call against this contract:\n${distillToolSchema(toolName, tool.parameters)}`,
        display: false,
      },
      { deliverAs: "steer" },
    );
    ctx.ui.notify(`[stuck-guard] injected ${toolName} parameter contract hint`, "info");
  });
}
