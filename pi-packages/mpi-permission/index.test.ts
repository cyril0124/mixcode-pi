import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  formatSkillsForPrompt,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parsePermissionConfig } from "./permission-core.js";

function jsonFences(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    out.push(match[1]!.trim());
  }
  return out;
}

test("mpi-permission contributes a user-invoked skill from an installed extension package", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-permission-agent-"));
  try {
    const extensionsDir = path.join(agentDir, "extensions");
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.symlink(import.meta.dirname, path.join(extensionsDir, "mpi-permission"));

    const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(agentDir),
    });
    await session.bindExtensions({ mode: "print" });
    assert.ok(session.getAllTools().some((tool) => tool.name === "permission_probe"));
    assert.equal(session.getActiveToolNames().includes("permission_probe"), false);

    const loaded = services.resourceLoader.getSkills();
    const skill = loaded.skills.find((entry) => entry.name === "mpi-permission");
    assert.ok(skill);
    assert.equal(skill.disableModelInvocation, true);
    const body = await fs.readFile(skill.filePath, "utf8");
    assert.match(body, /name: mpi-permission/);
    assert.match(body, /disable-model-invocation: true/);
    await assert.rejects(fs.stat(path.join(agentDir, "skills", "mpi-permission")), /ENOENT/);
    assert.doesNotMatch(formatSkillsForPrompt(loaded.skills), /mpi-permission/);

    const fences = jsonFences(body);
    assert.ok(fences.length >= 4);
    for (const raw of fences) {
      const parsed = parsePermissionConfig(JSON.parse(raw));
      assert.equal(parsed.ok, true, `skill JSON example must parse: ${raw}`);
    }
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
