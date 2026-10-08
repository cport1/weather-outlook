// Builds standalone executables with `bun build --compile` (no Bun or Node needed to run them).
//
//   bun scripts/compile.ts                 # every target
//   bun scripts/compile.ts darwin-arm64    # just the named targets
//
// OpenTUI loads a per-platform native library from @opentui/core-<platform>, which imports it
// with `{ type: "file" }`, so the compiler embeds it like any other asset. Cross-compiling
// therefore needs every platform package on disk: `bun install --os='*' --cpu='*'` (CI does this).
// OpenTUI picks the musl library only when OPENTUI_LIBC=musl at runtime, so musl builds bake
// that value in with `define`.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import solidPlugin from "@opentui/solid/bun-plugin";
import pkg from "../package.json" with { type: "json" };

interface Target {
  name: string;
  bun: Bun.Build.CompileTarget;
  pkg: string;
  musl?: boolean;
  exe?: string;
}

export const TARGETS: Target[] = [
  { name: "darwin-arm64", bun: "bun-darwin-arm64", pkg: "@opentui/core-darwin-arm64" },
  { name: "darwin-x64", bun: "bun-darwin-x64", pkg: "@opentui/core-darwin-x64" },
  { name: "linux-x64", bun: "bun-linux-x64", pkg: "@opentui/core-linux-x64" },
  { name: "linux-arm64", bun: "bun-linux-arm64", pkg: "@opentui/core-linux-arm64" },
  {
    name: "linux-x64-musl",
    bun: "bun-linux-x64-musl",
    pkg: "@opentui/core-linux-x64-musl",
    musl: true,
  },
  {
    name: "linux-arm64-musl",
    bun: "bun-linux-arm64-musl",
    pkg: "@opentui/core-linux-arm64-musl",
    musl: true,
  },
  { name: "windows-x64", bun: "bun-windows-x64", pkg: "@opentui/core-win32-x64", exe: ".exe" },
];

const OUT = "dist-bin";
const wanted = process.argv.slice(2);
const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS;
if (!targets.length) {
  console.error(`unknown target(s): ${wanted.join(", ")}. Known: ${TARGETS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

await Bun.$`mkdir -p ${OUT}`;
const sums: string[] = [];
for (const t of targets) {
  if (!existsSync(`node_modules/${t.pkg}`)) {
    console.error(`${t.pkg} is not installed; run: bun install --os='*' --cpu='*'`);
    process.exit(1);
  }
  const file = `weather-outlook-${pkg.version}-${t.name}${t.exe ?? ""}`;
  const outfile = `${OUT}/${file}`;
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: ["src/cli.ts"],
    target: "bun",
    plugins: [solidPlugin],
    minify: true,
    define: t.musl ? { "process.env.OPENTUI_LIBC": JSON.stringify("musl") } : {},
    compile: {
      target: t.bun,
      outfile,
      // Don't let a stray bunfig.toml / .env next to the user's cwd change behavior.
      autoloadBunfig: false,
      autoloadDotenv: false,
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const bytes = await Bun.file(outfile).bytes();
  const sha = createHash("sha256").update(bytes).digest("hex");
  sums.push(`${sha}  ${file}`);
  await Bun.write(`${outfile}.sha256`, `${sha}  ${file}\n`);
  const mb = (bytes.length / 1024 / 1024).toFixed(1);
  console.log(`${outfile}  ${mb} MB  (${((performance.now() - started) / 1000).toFixed(1)}s)`);
}
await Bun.write(`${OUT}/SHA256SUMS`, `${sums.join("\n")}\n`);
