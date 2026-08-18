import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab } from "./helpers/mixcode.js";
import { formatExtensionSummaries } from "../src/agent/runtime-startup-header.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("extension startup labels match Pi compact and expanded forms", () => {
  const summaries = formatExtensionSummaries([
    {
      path: "/tmp/agent/extensions/alpha/index.ts",
      source: "local",
      scope: "temporary",
      origin: "top-level",
    },
    {
      path: "/tmp/agent/extensions/beta/index.ts",
      source: "local",
      scope: "temporary",
      origin: "top-level",
    },
    {
      path: "/repo/one/extension/index.ts",
      source: "local",
      scope: "project",
      origin: "top-level",
    },
    {
      path: "/repo/two/extension/index.ts",
      source: "local",
      scope: "project",
      origin: "top-level",
    },
    {
      path: "/home/user/node_modules/@scope/pkg/extensions/feature/index.ts",
      source: "npm:@scope/pkg",
      scope: "user",
      origin: "package",
      baseDir: "/home/user/node_modules/@scope/pkg",
    },
    {
      path: "/home/user/.pi/agent/git/github.com/acme/widgets/extensions/report/index.ts",
      source: "git:https://github.com/acme/widgets.git",
      scope: "user",
      origin: "package",
      baseDir: "/home/user/.pi/agent/git/github.com/acme/widgets",
    },
  ]);

  assert.deepEqual(summaries.compact, [
    "@scope/pkg:feature",
    "acme/widgets:report",
    "alpha",
    "beta",
    "one/extension",
    "two/extension",
  ]);
  assert.deepEqual(summaries.expanded, [
    "  project",
    "    /repo/one/extension",
    "    /repo/two/extension",
    "  user",
    "    git:https://github.com/acme/widgets.git",
    "      extensions/report",
    "    npm:@scope/pkg",
    "      extensions/feature",
    "  path",
    "    /tmp/agent/extensions/alpha",
    "    /tmp/agent/extensions/beta",
  ]);
});

test("startup summary follows the existing tools-expanded toggle", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.startupSummary = "[Extensions]\n  path\n    /tmp/agent/extensions/alpha";
  (tab as typeof tab & { startupSummaryCompact?: string }).startupSummaryCompact =
    "[Extensions]\n  alpha";

  const compact = stripAnsi(renderAgentSurface(tab, undefined, 100, 40).join("\n"));
  assert.match(compact, /alpha/);
  assert.doesNotMatch(compact, /\/tmp\/agent/);

  tab.extensionUi.toolsExpanded = true;
  const expanded = stripAnsi(renderAgentSurface(tab, undefined, 100, 40).join("\n"));
  assert.match(expanded, /\/tmp\/agent\/extensions\/alpha/);
});
