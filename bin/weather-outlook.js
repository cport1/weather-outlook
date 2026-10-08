#!/usr/bin/env node
// Entry point for npm installs. The CLI runs on Bun (its TUI engine needs Bun's FFI):
//   1. already under Bun → run in-process
//   2. `bun` on PATH     → hand off to it
//   3. otherwise         → run the standalone binary from this version's GitHub release,
//                          downloaded once, SHA256-verified and cached.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const args = process.argv.slice(2);

if (process.versions.bun) {
  await import(cli);
} else {
  const viaBun = spawnSync("bun", [cli, ...args], { stdio: "inherit" });
  if (viaBun.error?.code !== "ENOENT") process.exit(viaBun.status ?? 1);
  process.exit(await runBinary());
}

function target() {
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!arch) return undefined;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return arch === "x64" ? "windows-x64" : undefined;
  if (process.platform === "linux") {
    // glibc reports its version here; musl (Alpine) doesn't.
    const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
    return `linux-${arch}${glibc ? "" : "-musl"}`;
  }
  return undefined;
}

function cacheDir() {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : join(homedir(), ".cache"));
  return join(base, "weather-outlook", "bin");
}

function noRuntime(reason) {
  console.error(
    `weather-outlook: ${reason}\n` +
      "  Install Bun (https://bun.sh):  curl -fsSL https://bun.sh/install | bash   (or: npm i -g bun)\n" +
      "  or download a standalone binary: https://github.com/cport1/weather-outlook/releases",
  );
  return 1;
}

/** Read a response body, drawing a percentage on stderr when it's a terminal. */
async function readWithProgress(res) {
  const total = Number(res.headers.get("content-length")) || 0;
  const show = process.stderr.isTTY && total > 0;
  const chunks = [];
  let got = 0;
  let shown = -1;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    const pct = Math.floor((got / total) * 100);
    if (show && pct !== shown) {
      shown = pct;
      const mb = (n) => (n / 1048576).toFixed(0);
      process.stderr.write(`\r  ${String(pct).padStart(3)}%  ${mb(got)} / ${mb(total)} MB`);
    }
  }
  if (show) process.stderr.write("\r\x1b[2K");
  return Buffer.concat(chunks);
}

async function runBinary() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const t = target();
  if (!t) return noRuntime(`no prebuilt binary for ${process.platform}-${process.arch}.`);
  const name = `weather-outlook-${version}-${t}${t.startsWith("windows") ? ".exe" : ""}`;
  const dir = join(cacheDir(), version);
  const file = join(dir, name);

  if (!existsSync(file)) {
    if (process.env.WEATHER_OUTLOOK_NO_DOWNLOAD) return noRuntime("Bun isn't installed.");
    const base = `https://github.com/cport1/weather-outlook/releases/download/v${version}`;
    try {
      process.stderr.write(`Downloading weather-outlook ${version} for ${t} (one time)…\n`);
      const [bin, sum] = await Promise.all([
        fetch(`${base}/${name}`).then((r) => {
          if (!r.ok) throw new Error(`${r.status} for ${name}`);
          return readWithProgress(r);
        }),
        fetch(`${base}/${name}.sha256`).then((r) => {
          if (!r.ok) throw new Error(`${r.status} for ${name}.sha256`);
          return r.text();
        }),
      ]);
      const expected = sum.trim().split(/\s+/)[0];
      const actual = createHash("sha256").update(bin).digest("hex");
      if (expected !== actual) throw new Error(`checksum mismatch for ${name}`);
      mkdirSync(dir, { recursive: true });
      // Write-then-rename so an interrupted download never leaves a broken binary.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, bin);
      chmodSync(tmp, 0o755);
      renameSync(tmp, file);
    } catch (err) {
      return noRuntime(`couldn't fetch the standalone binary (${err.message}).`);
    }
  }
  const res = spawnSync(file, args, { stdio: "inherit" });
  if (res.error) return noRuntime(`couldn't start ${file} (${res.error.message}).`);
  return res.status ?? 1;
}
