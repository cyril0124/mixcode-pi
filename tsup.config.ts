import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "cli/main": "src/cli/main.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
});
