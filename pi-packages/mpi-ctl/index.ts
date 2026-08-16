import * as path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const mpiCtl: ExtensionFactory = (pi) => {
  // Built-in packages live under agentDir/extensions instead of Pi package settings.
  pi.on("resources_discover", () => ({
    skillPaths: [path.join(import.meta.dirname, "skills")],
  }));
};

export default mpiCtl;
