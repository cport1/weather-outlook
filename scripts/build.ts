// Bundles the CLI for publishing. The Solid JSX transform normally comes from the
// bunfig.toml preload, which doesn't apply once installed, so it runs at build time.
import solidPlugin from "@opentui/solid/bun-plugin";
import pkg from "../package.json" with { type: "json" };

// solid-js must be bundled: the plugin swaps its server build for the client build
// at bundle time. Left external, Bun resolves the server build at runtime and the
// dashboard dies with "Orphan text error". Everything else (incl. OpenTUI's native
// per-platform libs) stays external and resolves from node_modules.
const BUNDLED = new Set(["solid-js", "@opentui/solid"]);
const external = Object.keys(pkg.dependencies).filter((d) => !BUNDLED.has(d));

await Bun.$`rm -rf dist`;
const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist",
  target: "bun",
  // Keeps the dashboard in its own chunk so one-shot/JSON modes never load it.
  splitting: true,
  external,
  plugins: [solidPlugin],
  minify: { syntax: true, whitespace: true },
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const o of result.outputs) console.log(`${o.path.replace(`${process.cwd()}/`, "")}  ${(o.size / 1024).toFixed(1)} KB`);
