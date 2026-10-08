import type { MultiLineString } from "geojson";
import { mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import usStates from "us-atlas/states-10m.json" with { type: "json" };
import admin1 from "../data/admin1-lines.json" with { type: "json" };

/**
 * First-order administrative boundaries: US states from us-atlas (Census
 * 1:10m) plus Natural Earth 10m state/province lines for everywhere else,
 * pre-simplified by scripts/geodata.ts.
 */
const statesTopo = usStates as unknown as Topology<{ states: GeometryCollection }>;
const admin1Data = admin1 as unknown as { q: number; lines: number[][] };

let cached: MultiLineString | undefined;

/** Decode delta-encoded, quantized polylines. */
export function decodeLines(data: {
  q: number;
  lines: number[][];
}): Array<Array<[number, number]>> {
  return data.lines.map((enc) => {
    const out: Array<[number, number]> = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < enc.length; i += 2) {
      x += enc[i] ?? 0;
      y += enc[i + 1] ?? 0;
      out.push([x / data.q, y / data.q]);
    }
    return out;
  });
}

export function adminLines(): MultiLineString {
  if (cached) return cached;
  // Interior borders only (a !== b), so state lines never double the coastline.
  const us = mesh(statesTopo, statesTopo.objects.states, (a, b) => a !== b) as MultiLineString;
  cached = {
    type: "MultiLineString",
    coordinates: [...us.coordinates, ...decodeLines(admin1Data)],
  };
  return cached;
}
