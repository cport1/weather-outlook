import { expect, test } from "bun:test";

// Guards the published artifact: the dashboard must boot from dist/ in a real
// pseudo-terminal (headless test renderers don't catch build-only regressions).
test.skipIf(process.platform === "win32")(
  "built dashboard starts in a TTY and quits cleanly",
  async () => {
    await Bun.$`bun run build`.quiet();
    const out = `${process.env.TMPDIR ?? "/tmp"}/wo-tty-${process.pid}.txt`;
    // `script` provides a TTY; `q` is typed after the first frames render. Driven through
    // sh because macOS `script` can't use Bun's socket-backed pipes as its stdin.
    // Run from outside the repo so bunfig.toml's Solid preload can't mask build bugs.
    const cli = `${process.cwd()}/dist/cli.js`;
    const run = `bun '${cli}' 40.0,-105.0 --no-motion`;
    const cmd =
      process.platform === "darwin"
        ? `(sleep 2.5; printf q) | script -q '${out}' ${run}`
        : `(sleep 2.5; printf q) | script -qec '${run}' '${out}'`;
    const cwd = process.env.TMPDIR ?? "/tmp";
    await Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
    const text = await Bun.file(out).text();
    expect(text).not.toContain("Orphan text error");
    expect(text).not.toContain("weather-outlook: ");
    expect(text).toContain("weather-outlook");
  },
  20_000,
);
