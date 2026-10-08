import { createInterface } from "node:readline/promises";
import type { Location } from "../domain/types.ts";
import { describePlace } from "../providers/location.ts";

/** Parse a 1-based menu answer; blank or junk picks the first entry. */
export function parseChoice(answer: string, count: number): number {
  const n = Number.parseInt(answer.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : 0;
}

/**
 * Numbered picker for ambiguous place names. Talks over stderr so stdout
 * stays clean for `--json` and pipes.
 */
export async function pickLocation(query: string, choices: Location[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`Several places match "${query}":\n`);
    choices.forEach((c, i) => {
      const where = `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`;
      process.stderr.write(`  ${String(i + 1).padStart(2)}) ${describePlace(c)}  (${where})\n`);
    });
    const answer = await rl.question(`Pick 1-${choices.length} [1]: `);
    return parseChoice(answer, choices.length);
  } finally {
    rl.close();
  }
}
