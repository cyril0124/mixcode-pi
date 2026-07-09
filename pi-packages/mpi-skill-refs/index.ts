// +---------------------------------------------------------------------------+
// |  skill-refs extension                                                     |
// |  Expands `$SkillName` references in user prompts into a hidden custom     |
// |  message (display:false) so the LLM sees the skill pointers while the     |
// |  user message stays verbatim in the session (no separator stripping).     |
// |                                                                           |
// |  Event split:                                                             |
// |  - before_agent_start: idle prompt path. Refreshes the authoritative      |
// |    skill list from systemPromptOptions.skills (covers extension-          |
// |    contributed skills) and returns the injected message for this turn.    |
// |  - input: only handles streaming steer/followUp (before_agent_start does  |
// |    not fire for queued messages); resolves from the warm cache and sends  |
// |    the block with a matching deliverAs.                                   |
// |  - session_start: cold-start filesystem scan so $ autocomplete works      |
// |    before the first prompt; also registers the autocomplete wrapper.     |
// +---------------------------------------------------------------------------+
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
    scanned = await scanSkillDirs(ctx.cwd);
    if (!autocompleteRegistered) {
      autocompleteRegistered = true;
      ctx.ui.addAutocompleteProvider((base) => createSkillCompletionWrapper(base, completionEntries));
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

  pi.on("input", (event) => {
    // Idle input is handled by before_agent_start in the same prompt() call.
    // streamingBehavior is only defined while the agent is streaming, where
    // before_agent_start will not fire for the queued message.
    if (!event.streamingBehavior) return;
    const resolved = resolveRefs(event.text);
    if (resolved.length === 0) return;
    pi.sendMessage(
      {
        customType: CUSTOM_MESSAGE_TYPE,
        content: buildSkillBlock(resolved),
        display: false,
      },
      { deliverAs: event.streamingBehavior },
    );
  });
}
