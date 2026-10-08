export type RGB = readonly [number, number, number];

export function hex(h: string): RGB {
  const s = h.replace("#", "");
  return [
    Number.parseInt(s.slice(0, 2), 16),
    Number.parseInt(s.slice(2, 4), 16),
    Number.parseInt(s.slice(4, 6), 16),
  ];
}

export function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

export function lerp(a: RGB, b: RGB, t: number): RGB {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Piecewise-linear color scale over sorted stops. */
export function scale(stops: ReadonlyArray<readonly [number, string]>): (v: number) => RGB {
  const parsed = stops.map(([v, c]) => [v, hex(c)] as const);
  return (v: number) => {
    const first = parsed[0];
    const last = parsed[parsed.length - 1];
    if (!first || !last) return [255, 255, 255];
    if (v <= first[0]) return first[1];
    if (v >= last[0]) return last[1];
    for (let i = 1; i < parsed.length; i++) {
      const hi = parsed[i];
      const lo = parsed[i - 1];
      if (hi && lo && v <= hi[0]) return lerp(lo[1], hi[1], (v - lo[0]) / (hi[0] - lo[0]));
    }
    return last[1];
  };
}

/** Temperature in °C → color, tuned to read well on dark backgrounds. */
export const temperatureScale = scale([
  [-30, "#b388ff"],
  [-15, "#7c9cff"],
  [0, "#4fc3f7"],
  [10, "#4dd0a8"],
  [18, "#c6e05a"],
  [25, "#ffd54f"],
  [32, "#ff8a3d"],
  [40, "#ff3d3d"],
  [48, "#c2185b"],
]);

/** Radar reflectivity (dBZ) → classic NWS-ish palette. */
export const reflectivityScale = scale([
  [5, "#04e9e7"],
  [15, "#019ff4"],
  [20, "#02fd02"],
  [30, "#01c501"],
  [35, "#fdf802"],
  [40, "#e5bc00"],
  [45, "#fd9500"],
  [50, "#fd0000"],
  [55, "#d40000"],
  [60, "#f800fd"],
  [70, "#ffffff"],
]);

/** US AQI → EPA category colors. */
export const aqiScale = scale([
  [0, "#00e400"],
  [50, "#00e400"],
  [51, "#ffff00"],
  [100, "#ffff00"],
  [101, "#ff7e00"],
  [150, "#ff7e00"],
  [151, "#ff0000"],
  [200, "#ff0000"],
  [201, "#8f3f97"],
  [300, "#8f3f97"],
  [301, "#7e0023"],
]);

/** Saffir-Simpson category (-1 = TD, 0 = TS) → color. */
export function stormCategoryColor(cat: number): RGB {
  const table: Record<number, string> = {
    [-1]: "#5ebaff",
    0: "#00faf4",
    1: "#ffffcc",
    2: "#ffe775",
    3: "#ffc140",
    4: "#ff8f20",
    5: "#ff6060",
  };
  return hex(table[Math.max(-1, Math.min(5, cat))] ?? "#ffffff");
}
