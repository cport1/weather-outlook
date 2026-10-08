#!/usr/bin/env bun
/** Regenerate schema/*.json from the zod domain types: `bun run schema`. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonSchemas, serializeSchema } from "../src/domain/schema.ts";

const dir = join(import.meta.dir, "..", "schema");
await mkdir(dir, { recursive: true });
for (const [name, doc] of Object.entries(jsonSchemas())) {
  await writeFile(join(dir, name), serializeSchema(doc));
  console.log(`wrote schema/${name}`);
}
