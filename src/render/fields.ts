import { type AuroraGrid, auroraAt } from "../providers/aurora.ts";
import { type FieldKind, type GlobalGrid, sampleGrid } from "../providers/global-grid.ts";
import { hex, lerp, type RGB, scale, temperatureScale } from "./color.ts";
import type { Units } from "./units.ts";
import type { MapLayers, PixelShader } from "./worldmap.ts";

/** Global field layers drawn under the coastlines. */
export const FIELD_KINDS: readonly FieldKind[] = ["temp", "wind", "precip", "clouds"];

export const FIELD_LABEL: Record<FieldKind, string> = {
  temp: "temperature",
  wind: "wind",
  precip: "precip",
  clouds: "clouds",
};

const windScale = scale([
  [0, "#1b2a49"],
  [10, "#2f5d8a"],
  [20, "#3fa0a0"],
  [35, "#9ccc65"],
  [50, "#ffd54f"],
  [70, "#ff8a3d"],
  [100, "#e53935"],
  [130, "#c2185b"],
]);
const precipScale = scale([
  [0.05, "#2e7d6b"],
  [0.5, "#43a047"],
  [1.5, "#fdd835"],
  [4, "#fb8c00"],
  [8, "#e53935"],
  [15, "#ab47bc"],
]);
const CLOUD = hex("#e8eef5");

interface FieldStyle {
  color(v: number): RGB | undefined;
  alpha: number;
  /** Legend stops in the field's native unit (°C, km/h, mm, %). */
  stops: number[];
}

const STYLE: Record<FieldKind, FieldStyle> = {
  temp: { color: temperatureScale, alpha: 0.78, stops: [-30, -15, 0, 10, 20, 30, 40] },
  wind: { color: windScale, alpha: 0.75, stops: [0, 10, 20, 35, 50, 70, 100] },
  precip: {
    color: (v) => (v < 0.05 ? undefined : precipScale(v)),
    alpha: 0.8,
    stops: [0.1, 0.5, 1.5, 4, 8, 15],
  },
  clouds: {
    color: (v) => (v < 10 ? undefined : lerp(hex("#5d6b78"), CLOUD, (v - 10) / 90)),
    alpha: 0.6,
    stops: [20, 40, 60, 80, 100],
  },
};

/** Map layers for a global field (temperature, wind, …) sampled from the coarse grid. */
export function fieldLayer(
  grid: GlobalGrid,
  kind: FieldKind,
): Pick<MapLayers, "field" | "fieldAlpha"> {
  const style = STYLE[kind];
  const data = grid.values[kind];
  return {
    fieldAlpha: style.alpha,
    field: (lon, lat) => {
      const v = sampleGrid(grid, data, lon, lat);
      return Number.isNaN(v) ? undefined : style.color(v);
    },
  };
}

export interface LegendEntry {
  label: string;
  color: RGB;
}

/** Color ramp entries for a field's legend, in the user's units. */
export function fieldLegend(
  kind: FieldKind,
  units: Units,
): { title: string; entries: LegendEntry[] } {
  const style = STYLE[kind];
  const imperial = units === "imperial";
  const fmt = (v: number): string => {
    switch (kind) {
      case "temp":
        return `${Math.round(imperial ? (v * 9) / 5 + 32 : v)}°`;
      case "wind":
        return `${Math.round(imperial ? v / 1.609 : v)}`;
      case "precip":
        return imperial ? `${+(v / 25.4).toFixed(2)}`.replace(/^0\./, ".") : `${v}`;
      case "clouds":
        return `${v}%`;
    }
  };
  const unit =
    kind === "temp"
      ? imperial
        ? "°F"
        : "°C"
      : kind === "wind"
        ? imperial
          ? "mph"
          : "km/h"
        : kind === "precip"
          ? imperial
            ? "in"
            : "mm"
          : "cover";
  return {
    title: `${FIELD_LABEL[kind]} ${unit}`,
    entries: style.stops.map((v) => ({ label: fmt(v), color: style.color(v) ?? CLOUD })),
  };
}

const AURORA_LOW = hex("#2bff88");
const AURORA_HIGH = hex("#d05cff");

/** Green-to-violet glow where OVATION gives a meaningful aurora probability. */
export function auroraShader(g: AuroraGrid): PixelShader {
  return (lon, lat, c) => {
    if (Math.abs(lat) < 40) return c;
    const p = auroraAt(g, lon, lat);
    // OVATION reports a faint 1–5% haze over the whole polar cap; only draw the oval itself.
    if (p < 6) return c;
    const glow = lerp(AURORA_LOW, AURORA_HIGH, (p - 15) / 50);
    return lerp(c, glow, Math.min(0.85, (p - 4) / 16));
  };
}
