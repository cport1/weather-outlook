import { z } from "zod";
import { Hazards, Report, SCHEMA_VERSION } from "./types.ts";

/**
 * JSON Schema documents for the `--json` outputs, generated from the zod
 * types so they can never drift. `bun run schema` writes them to schema/;
 * a test fails if the committed copies are stale.
 */
const BASE = "https://raw.githubusercontent.com/cport1/weather-outlook/master/schema";

function document(schema: z.ZodType, name: string, title: string, description: string) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" });
  return { $schema: json.$schema, $id: `${BASE}/${name}`, title, description, ...json };
}

export function jsonSchemas(): Record<string, unknown> {
  return {
    [`report.v${SCHEMA_VERSION}.json`]: document(
      Report,
      `report.v${SCHEMA_VERSION}.json`,
      "weather-outlook report",
      "Output of `weather-outlook --json`. All values are metric/SI regardless of --units.",
    ),
    [`hazards.v${SCHEMA_VERSION}.json`]: document(
      Hazards,
      `hazards.v${SCHEMA_VERSION}.json`,
      "weather-outlook hazards",
      "Output of `weather-outlook hazards --json`.",
    ),
  };
}

export const serializeSchema = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
