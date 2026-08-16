import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

test("mpi-ctl contributes its skill from an installed extension package", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-agent-"));
  try {
    const extensionsDir = path.join(agentDir, "extensions");
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.symlink(import.meta.dirname, path.join(extensionsDir, "mpi-ctl"));

    const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(agentDir),
    });
    await session.bindExtensions({ mode: "print" });

    const skill = services.resourceLoader.getSkills().skills.find((entry) => entry.name === "mpi-ctl");
    assert.ok(skill);
    assert.match(await fs.readFile(skill.filePath, "utf8"), /name: mpi-ctl/);
    await assert.rejects(fs.stat(path.join(agentDir, "skills", "mpi-ctl")), /ENOENT/);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
