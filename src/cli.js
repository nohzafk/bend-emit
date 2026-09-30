#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

// Keep the source CLI as the single owner of argument handling and errors.
const source = fileURLToPath(new URL("./emit.ts", import.meta.url));
const child = Bun.spawnSync([process.execPath, source, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(child.exitCode);
