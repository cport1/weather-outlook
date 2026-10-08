import { aqiScale } from "../../render/color.ts";
import { aqiLabel, arcGauge, compassRose, uvLabel, uvScale } from "../../render/gauges.ts";
import type { DrawApi } from "../cell-canvas.ts";
import { theme } from "../theme.ts";

export const GAUGES_WIDTH = 41;
export const GAUGES_HEIGHT = 6;

/**
 * Compass rose (animated arrow that sways with gustiness) plus UV and AQI arc
 * gauges, drawn into one canvas strip for the Now panel.
 */
export function Gauges(props: {
  windDirection?: number;
  windSpeed?: number;
  windGust?: number;
  uv?: number;
  aqi?: number;
  motion: boolean;
}) {
  let clock = 0;
  const draw = (api: DrawApi, _w: number, _h: number, dt: number) => {
    if (props.motion) clock += dt;
    const from = props.windDirection;
    const speed = props.windSpeed ?? 0;
    const gust = props.windGust ?? speed;
    const gustiness = Math.max(0, Math.min(1, (gust - speed) / Math.max(8, speed)));
    const sway = props.motion
      ? Math.sin(clock / 650) * (2 + gustiness * 6) + Math.sin(clock / 170) * gustiness * 4
      : 0;

    // ── Compass ──
    const toward = from === undefined ? 0 : (from + 180 + sway) % 360;
    api.grid(
      compassRose(
        13,
        GAUGES_HEIGHT,
        toward,
        theme.faint,
        from === undefined ? theme.faint : theme.accent,
        theme.dim,
      ),
      0,
      0,
    );
    api.text(6, 0, "N", theme.text);
    api.text(6, GAUGES_HEIGHT - 1, "S", theme.dim);
    api.text(0, 2, "W", theme.dim);
    api.text(12, 2, "E", theme.dim);

    // ── Arc gauges ──
    const gauge = (
      x: number,
      title: string,
      value: number | undefined,
      max: number,
      colorFor: (v: number) => readonly [number, number, number],
      label: (v: number) => string,
    ) => {
      const v = value ?? 0;
      api.grid(arcGauge(v, max, 13, 4, colorFor, theme.faint), x, 0);
      const num = value === undefined ? "--" : String(Math.round(v));
      const head = `${title} ${num}`;
      api.text(x + Math.floor((13 - head.length) / 2), 3, title, theme.dim);
      api.text(
        x + Math.floor((13 - head.length) / 2) + title.length + 1,
        3,
        num,
        value === undefined ? theme.dim : colorFor(v),
      );
      const l = value === undefined ? "" : label(v);
      api.text(
        x + Math.floor((13 - l.length) / 2),
        4,
        l,
        value === undefined ? theme.dim : colorFor(v),
      );
    };
    gauge(14, "UV", props.uv, 11, uvScale, uvLabel);
    gauge(28, "AQI", props.aqi, 300, aqiScale, aqiLabel);
  };
  return (
    <cell_canvas
      live={props.motion}
      width={GAUGES_WIDTH}
      height={GAUGES_HEIGHT}
      flexShrink={0}
      draw={draw}
    />
  );
}
