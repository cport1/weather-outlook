import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

// Guards the standalone executables: OpenTUI's native library must be embedded and found
// without node_modules, and the dashboard must boot in a real pseudo-terminal.
const HOST = `${process.platform}-${process.arch}`;
const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);

test.skipIf(!SUPPORTED.has(HOST) || process.env.SKIP_COMPILE_TEST === "1")(
  "compiled binary runs one-shot and boots the dashboard in a TTY",
  async () => {
    await Bun.$`bun scripts/compile.ts ${HOST}`.quiet();
    const bin = `${process.cwd()}/dist-bin/weather-outlook-${pkg.version}-${HOST}`;
    // Run from outside the repo so node_modules can't satisfy the native import.
    const cwd = process.env.TMPDIR ?? "/tmp";

    const version = await Bun.$`${bin} --version`.cwd(cwd).text();
    expect(version.trim()).toBe(pkg.version);

    const out = `${cwd}/wo-bin-tty-${process.pid}.txt`;
    const run = `'${bin}' 40.0,-105.0 --no-motion`;
    const cmd =
      process.platform === "darwin"
        ? `(sleep 3; printf q) | script -q '${out}' ${run}`
        : `(sleep 3; printf q) | script -qec "${run}" '${out}'`;
    await Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
    const text = await Bun.file(out).text();
    expect(text).not.toContain("OpenTUI is not supported");
    expect(text).not.toContain("weather-outlook: ");
    expect(text).toContain("weather-outlook");
    // The view tabs only render once the OpenTUI renderer is up.
    expect(text).toContain("Radar");
  },
  60_000,
);
