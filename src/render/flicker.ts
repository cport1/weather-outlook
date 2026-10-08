import type { Fire } from "../domain/types.ts";
import { hex, lerp, type RGB } from "./color.ts";

const EMBER = hex("#bf360c");
const FLAME = hex("#ff7043");
const HOT = hex("#ffeb3b");

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

/**
 * Flickering fire sprite at time t (ms): each fire gets its own phase so a
 * cluster shimmers rather than blinking in unison. Contained fires don't flicker.
 */
export function fireFlicker(f: Fire, t: number): { glyph: string; color: RGB } | undefined {
  if ((f.containment ?? 0) >= 100) return undefined;
  const phase = hash(f.id) * Math.PI * 2;
  // Two incommensurate waves read as organic flicker.
  const k = (Math.sin(t / 130 + phase) + Math.sin(t / 47 + phase * 3) * 0.5 + 1.5) / 3;
  const color = k < 0.5 ? lerp(EMBER, FLAME, k * 2) : lerp(FLAME, HOT, (k - 0.5) * 2);
  return { glyph: k < 0.22 ? "▴" : "▲", color };
}
