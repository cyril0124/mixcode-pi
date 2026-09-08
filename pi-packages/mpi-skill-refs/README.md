# mpi-skill-refs

[中文](README.zh.md)

Completes `$SkillName` references and supplies the model with each resolved skill's name, description, `SKILL.md` path, and base directory. User messages remain verbatim in chat and session history. The extension supplies pointers; the model reads the skill file.

Type `$` in the prompt editor for suggestions, or submit text such as `apply $review to this diff`. Unknown names, common environment variables, fenced code blocks, and shell-mode input (`!` / `!!`) do not expand.

## Delivery and persistence

- Idle prompts receive a hidden `skill-refs` custom message through `before_agent_start`. Pi persists it alongside the user message.
- Steer and follow-up prompts receive their reference block through the `context` event, after the original user message is delivered. These blocks affect the model request only; they are reconstructed from delivered user messages on later requests and resume.
- Skill metadata never occupies a separate queue entry or starts a model turn. Withdrawing an undelivered prompt also prevents its skills from reaching the model. Input handlers that consume or transform the prompt leave only the accepted user text eligible for expansion.
- Identical blocks already present in context are reused, including persisted blocks from idle prompts. Existing session entries are preserved.

## Skill discovery

`session_start` scans project, user, and installed package skill directories for autocomplete and initial lookup. `before_agent_start` refreshes the authoritative list from Pi's `systemPromptOptions.skills`, including skills contributed by extensions. Names absent from that list fall back to the scanned entries.

Set `MIXCODE_PROJECT_SKILLS_ONLY=1` to restrict the filesystem scan to `<cwd>/.agents/skills`. Unset, empty, `0`, `false`, `off`, and `no` disable this restriction; values are trimmed and case-insensitive. This setting controls the scan only, not the skill list supplied by Pi's resource loader.
