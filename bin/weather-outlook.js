#!/usr/bin/env node
// Entry point for npm installs. The CLI runs on Bun (its TUI engine needs Bun's FFI),
// so under Node we hand off to a `bun` on PATH or explain how to get one.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

if (process.versions.bun) {
  await import(cli);
} else {
  const res = spawnSync("bun", [cli, ...process.argv.slice(2)], { stdio: "inherit" });
  if (res.error?.code === "ENOENT") {
    console.error(
      "weather-outlook needs the Bun runtime (https://bun.sh).\n" +
        "  Install it:  curl -fsSL https://bun.sh/install | bash   (or: npm i -g bun)\n" +
        "  Or run it directly:  bunx weather-outlook",
    );
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
