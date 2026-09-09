import {
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  SkillInvocationMessageComponent,
  type ParsedSkillBlock,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
} from "../../agent/runtime-extension-theme.js";
import type { ChatSummaryMessage } from "../../agent/runtime-types.js";
import { applyMixCodeKeybindings } from "../../agent/runtime-pi-tui-bridge.js";
import { applyPiThemeInstance } from "../pi-theme-api.js";
import { resolvePiTheme } from "../themes.js";
import { activeRenderTheme } from "./context.js";
import { getMarkdownTheme, transformMessageCardMarkdown } from "./markdown.js";

export function renderSkillCard(
  skill: ParsedSkillBlock,
  width: number,
  expanded: boolean,
): string[] {
  return renderWithCardGlobals((theme) => {
    const content = expanded
      ? transformMessageCardMarkdown(skill.content, width, theme)
      : skill.content;
    const component = new SkillInvocationMessageComponent(
      { ...skill, content },
      getMarkdownTheme(),
    );
    if (expanded) component.setExpanded(true);
    return component.render(width);
  });
}

export function renderSummaryCard(
  message: ChatSummaryMessage,
  width: number,
  expanded: boolean,
): string[] {
  return renderWithCardGlobals((theme) => {
    const prepared = {
      ...message,
      summary: expanded
        ? transformMessageCardMarkdown(message.summary, width, theme)
        : message.summary,
    };
    const markdownTheme = getMarkdownTheme();
    const component =
      prepared.role === "branchSummary"
        ? new BranchSummaryMessageComponent(prepared, markdownTheme)
        : new CompactionSummaryMessageComponent(prepared, markdownTheme);
    if (expanded) component.setExpanded(true);
    return component.render(width);
  });
}

// Pi cards read global theme and keybindings during construction as well as
// rendering. Keep this scope synchronous and restore the host's globals so
// off-screen tab rendering cannot change another tab's presentation.
function renderWithCardGlobals(render: (theme: Theme) => string[]): string[] {
  ensureExtensionThemeInitialized();
  const previousTheme = currentExtensionTheme();
  const theme = resolvePiTheme(activeRenderTheme.name) ?? previousTheme;
  const restoreKeybindings = applyMixCodeKeybindings();
  const switchesTheme = theme !== previousTheme;
  if (switchesTheme) applyPiThemeInstance(theme);
  try {
    return render(theme);
  } finally {
    if (switchesTheme) applyPiThemeInstance(previousTheme);
    restoreKeybindings();
  }
}
