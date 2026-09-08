// Resolve `$SkillName` references without changing persisted user messages.
// Idle prompts persist their hidden reference block through before_agent_start.
// Queued prompts gain references only in the model context after delivery, so
// skill metadata cannot run ahead of its user message or survive withdrawal.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildSkillBlock,
  createSkillCompletionWrapper,
  extractSkillRefs,
  scanSkillDirs,
  type ResolvedSkillRef,
  type SkillRefEntry,
} from "./skill-core.js";

const CUSTOM_MESSAGE_TYPE = "skill-refs";

// Shared in-flight scan: boot restores N tabs concurrently; identical
// concurrent attaches join the running filesystem walk instead of repeating
// it per tab. No TTL — once idle, the next attach scans fresh, so newly added
// skills appear immediately. The finally-delete is identity-checked so a
// settled scan cannot evict a newer one.
const inflightSkillScans = new Map<string, Promise<Map<string, SkillRefEntry>>>();

function scanSkillDirsShared(cwd: string): Promise<Map<string, SkillRefEntry>> {
  const inflight = inflightSkillScans.get(cwd);
  if (inflight) return inflight;
  const value = scanSkillDirs(cwd).finally(() => {
    if (inflightSkillScans.get(cwd) === value) inflightSkillScans.delete(cwd);
  });
  inflightSkillScans.set(cwd, value);
  return value;
}

export default function (pi: ExtensionAPI) {
  // Authoritative list from Pi's resource loader; replaced every turn.
  let authoritative = new Map<string, SkillRefEntry>();
  // Cold-start filesystem scan; only consulted when a name is not authoritative.
  let scanned = new Map<string, SkillRefEntry>();
  let autocompleteRegistered = false;

  function lookup(name: string): ResolvedSkillRef | undefined {
    const entry = authoritative.get(name) ?? scanned.get(name);
    if (!entry?.filePath || !entry.baseDir) return undefined;
    return {
      name: entry.name,
      filePath: entry.filePath,
      baseDir: entry.baseDir,
      description: entry.description ?? "",
    };
  }

  function resolveRefs(text: string): ResolvedSkillRef[] {
    const resolved: ResolvedSkillRef[] = [];
    for (const name of extractSkillRefs(text)) {
      const skill = lookup(name);
      // Unresolved names are silently skipped (explicit product decision).
      if (skill) resolved.push(skill);
    }
    return resolved;
  }

  function completionEntries(): SkillRefEntry[] {
    const merged = new Map<string, SkillRefEntry>(scanned);
    for (const [name, entry] of authoritative) merged.set(name, entry);
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  pi.on("session_start", async (_event, ctx) => {
    // Refresh the cold-start scan on every (re)start so newly added skills
    // appear in completion without waiting for the first prompt.
    scanned = await scanSkillDirsShared(ctx.cwd);
    if (!autocompleteRegistered) {
      autocompleteRegistered = true;
      ctx.ui.addAutocompleteProvider((base) =>
        createSkillCompletionWrapper(base, completionEntries),
      );
    }
  });

  pi.on("before_agent_start", (event) => {
    // systemPromptOptions.skills is the complete loaded set (project, user,
    // and extension-contributed). Replace — do not merge — so removed skills
    // drop out after /reload.
    const skills = event.systemPromptOptions.skills;
    if (skills) {
      authoritative = new Map(
        skills.map((skill) => [
          skill.name,
          {
            name: skill.name,
            filePath: skill.filePath,
            baseDir: skill.baseDir,
            description: skill.description,
          },
        ]),
      );
    }
    const resolved = resolveRefs(event.prompt);
    if (resolved.length === 0) return;
    return {
      message: {
        customType: CUSTOM_MESSAGE_TYPE,
        content: buildSkillBlock(resolved),
        display: false,
      },
    };
  });

  pi.on("context", (event) => {
    // Context contains delivered messages only. An input handler runs before
    // the user is queued, and a separate custom queue entry would be consumed
    // independently in one-at-a-time mode or remain after Ctrl+U withdrawal.
    const existingBlocks = new Set(
      event.messages.flatMap((message) =>
        message.role === "custom" &&
        message.customType === CUSTOM_MESSAGE_TYPE &&
        typeof message.content === "string"
          ? [message.content]
          : [],
      ),
    );
    const messages: typeof event.messages = [];
    let changed = false;
    for (const message of event.messages) {
      messages.push(message);
      if (message.role !== "user") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      const resolved = resolveRefs(text);
      if (resolved.length === 0) continue;
      const content = buildSkillBlock(resolved);
      // Idle prompts and replayed sessions may already carry this block.
      if (existingBlocks.has(content)) continue;
      existingBlocks.add(content);
      messages.push({
        role: "custom",
        customType: CUSTOM_MESSAGE_TYPE,
        content,
        display: false,
        timestamp: message.timestamp,
      });
      changed = true;
    }
    // The context projection is rebuilt for each request; session history and
    // queue ownership stay with Pi's original user messages.
    if (changed) return { messages };
  });
}
