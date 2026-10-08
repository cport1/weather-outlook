import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, For, on } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { conditionGlyph } from "../../domain/conditions.ts";
import type { HourlyPoint, Report } from "../../domain/types.ts";
import { type Cell, PixelCanvas } from "../../render/canvas.ts";
import { hex, lerp, type RGB, scale, temperatureScale } from "../../render/color.ts";
import { uvScale } from "../../render/gauges.ts";
import { precip, speed, temp, windArrow } from "../../render/units.ts";
import type { CellCanvas, DrawApi } from "../cell-canvas.ts";
import { currentHourIndex, hexOf, precipScale, shortHour, tcolor } from "../format.ts";
import type { AppState, HourSeries } from "../store.ts";
import { T, theme } from "../theme.ts";

export const HOURS = 48;
const LABEL_W = 13;

const windScale = scale([
  [0, "#80cbc4"],
  [20, "#4dd0e1"],
  [40, "#ffd54f"],
  [60, "#ff8a65"],
  [90, "#e040fb"],
]);
const humidityScale = scale([
  [0, "#d7ccc8"],
  [40, "#81c784"],
  [70, "#4fc3f7"],
  [100, "#1e88e5"],
]);
const AMOUNT = hex("#00e5ff");

export const SERIES_KEYS: Array<[keyof HourSeries, string, string]> = [
  ["temp", "t", "temp"],
  ["precip", "p", "precip"],
  ["wind", "w", "wind"],
  ["humidity", "h", "humidity"],
  ["uv", "v", "UV"],
];

/** The 48-hour window starting at the current hour. */
export function hourlyWindow(report: Report): HourlyPoint[] {
  const f = report.forecast;
  if (!f) return [];
  const i = currentHourIndex(f.hourly);
  return f.hourly.slice(i, i + HOURS);
}

interface Group {
  key: keyof HourSeries;
  weight: number;
  render: (cols: number, rows: number) => Cell[][];
  label: (h: HourlyPoint) => Array<[string, string]>;
}

function lines(
  cols: number,
  rows: number,
  series: Array<{ values: Array<number | undefined>; color: (v: number) => RGB; dotted?: boolean }>,
  range: { min: number; max: number },
): Cell[][] {
  const c = new PixelCanvas(cols, rows);
  const span = range.max - range.min || 1;
  const n = series[0]?.values.length ?? 0;
  const xFor = (i: number) => (i / Math.max(1, n - 1)) * (c.width - 1);
  const yFor = (v: number) => (1 - (v - range.min) / span) * (c.height - 1);
  for (const s of series) {
    let prev: [number, number, number] | undefined;
    s.values.forEach((v, i) => {
      if (v === undefined || !Number.isFinite(v)) {
        prev = undefined;
        return;
      }
      const x = xFor(i);
      const y = yFor(v);
      if (s.dotted) {
        c.set(x, y, s.color(v));
      } else if (prev) {
        c.line(prev[0], prev[1], x, y, s.color((prev[2] + v) / 2));
      } else {
        c.set(x, y, s.color(v));
      }
      prev = [x, y, v];
    });
  }
  return c.toBraille();
}

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function bars(
  cols: number,
  rows: number,
  values: number[],
  max: number,
  colorAt: (i: number) => RGB,
): Cell[][] {
  const out: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ch: " " })),
  );
  const n = values.length;
  for (let x = 0; x < cols; x++) {
    const i = Math.round((x / Math.max(1, cols - 1)) * (n - 1));
    const v = values[i] ?? 0;
    let eighths = Math.round(Math.max(0, Math.min(1, v / max)) * rows * 8);
    if (v > 0 && eighths === 0) eighths = 1;
    const color = colorAt(i);
    for (let r = rows - 1; r >= 0 && eighths > 0; r--) {
      const k = Math.min(8, eighths);
      const row = out[r];
      if (row) row[x] = { ch: EIGHTHS[k] ?? "█", fg: color };
      eighths -= k;
    }
  }
  return out;
}

export function HourlyView(props: {
  state: AppState;
  setState: SetStoreFunction<AppState>;
  report: Report;
}) {
  const dims = useTerminalDimensions();
  const hours = createMemo(() => hourlyWindow(props.report));
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  const cursor = () => Math.min(props.state.hourCursor, Math.max(0, hours().length - 1));
  const sel = () => hours()[cursor()];
  let canvas: CellCanvas | undefined;
  let table: ScrollBoxRenderable | undefined;

  const groups = createMemo((): Group[] => {
    const hs = hours();
    const s = props.state.hourSeries;
    const units = u();
    const out: Group[] = [];
    if (s.temp) {
      const all = hs.flatMap((h) => [h.temperature, h.feelsLike ?? h.temperature]);
      const range = { min: Math.min(...all), max: Math.max(...all) };
      out.push({
        key: "temp",
        weight: 3,
        render: (cols, rows) =>
          lines(
            cols,
            rows,
            [
              { values: hs.map((h) => h.feelsLike), color: () => theme.dim, dotted: true },
              { values: hs.map((h) => h.temperature), color: temperatureScale },
            ],
            range,
          ),
        label: (h) => [
          [temp(h.temperature, units), tcolor(h.temperature)],
          [` ~${temp(h.feelsLike ?? h.temperature, units, false)}`, T.dim],
        ],
      });
    }
    if (s.precip) {
      const maxAmt = Math.max(2, ...hs.map((h) => h.precipitation ?? 0));
      out.push({
        key: "precip",
        weight: 2,
        render: (cols, rows) =>
          bars(
            cols,
            rows,
            hs.map((h) => h.precipitationProbability ?? 0),
            100,
            (i) => {
              const h = hs[i];
              const amt = h?.precipitation ?? 0;
              return amt > 0
                ? lerp(
                    precipScale(h?.precipitationProbability ?? 0),
                    AMOUNT,
                    0.4 + (0.6 * amt) / maxAmt,
                  )
                : precipScale(h?.precipitationProbability ?? 0);
            },
          ),
        label: (h) => [
          [
            `${Math.round(h.precipitationProbability ?? 0)}%`,
            hexOf(precipScale(h.precipitationProbability ?? 0)),
          ],
          [` ${precip(h.precipitation, units)}`, T.dim],
        ],
      });
    }
    if (s.wind) {
      const max = Math.max(10, ...hs.map((h) => h.windGust ?? h.windSpeed ?? 0));
      out.push({
        key: "wind",
        weight: 2,
        render: (cols, rows) =>
          lines(
            cols,
            rows,
            [
              { values: hs.map((h) => h.windGust), color: () => theme.faint, dotted: true },
              { values: hs.map((h) => h.windSpeed), color: windScale },
            ],
            { min: 0, max },
          ),
        label: (h) => [
          [
            `${windArrow(h.windDirection)} ${speed(h.windSpeed, units)}`,
            hexOf(windScale(h.windSpeed ?? 0)),
          ],
        ],
      });
    }
    if (s.humidity) {
      out.push({
        key: "humidity",
        weight: 1.5,
        render: (cols, rows) =>
          lines(cols, rows, [{ values: hs.map((h) => h.humidity), color: humidityScale }], {
            min: 0,
            max: 100,
          }),
        label: (h) => [[`${h.humidity ?? "--"}%`, hexOf(humidityScale(h.humidity ?? 0))]],
      });
    }
    if (s.uv) {
      out.push({
        key: "uv",
        weight: 1.5,
        render: (cols, rows) =>
          bars(
            cols,
            rows,
            hs.map((h) => h.uvIndex ?? 0),
            11,
            (i) => uvScale(hs[i]?.uvIndex ?? 0),
          ),
        label: (h) => [[`${Math.round(h.uvIndex ?? 0)}`, hexOf(uvScale(h.uvIndex ?? 0))]],
      });
    }
    return out;
  });

  // Charts take ~60% of the panel; the table gets the rest.
  const chartRows = () => {
    const inner = dims().height - 2 - 2 - 1;
    const n = groups().length;
    if (!n) return 1;
    return Math.max(n * 2 + 1, Math.min(n * 6 + 1, Math.floor(inner * 0.62)));
  };

  // Redraw the canvas when the cursor or data moves; keep the table row in view.
  createEffect(
    on([cursor, groups, () => props.state.units], () => {
      canvas?.requestRender();
      if (table) {
        const vh = table.viewport?.height ?? 4;
        const top = table.scrollTop;
        const c = cursor();
        if (c < top) table.scrollTop = c;
        else if (c >= top + vh) table.scrollTop = c - vh + 1;
      }
    }),
  );

  const layout = (w: number, h: number) => {
    const gs = groups();
    const rowsAvail = Math.max(gs.length, h - 1);
    const total = gs.reduce((a, g) => a + g.weight, 0) || 1;
    let used = 0;
    return gs.map((g, i) => {
      const rows =
        i === gs.length - 1
          ? rowsAvail - used
          : Math.max(1, Math.round((g.weight / total) * rowsAvail));
      const top = used;
      used += rows;
      return { g, top, rows, cols: Math.max(4, w - LABEL_W) };
    });
  };

  const colFor = (idx: number, cols: number) =>
    Math.round((idx / Math.max(1, hours().length - 1)) * (cols - 1));

  const draw = (api: DrawApi, w: number, h: number) => {
    const hs = hours();
    if (!hs.length) return;
    const cur = cursor();
    const cols = Math.max(4, w - LABEL_W);
    const cx = LABEL_W + colFor(cur, cols);
    const sh = hs[cur];
    for (const { g, top, rows } of layout(w, h)) {
      const grid = g.render(cols, rows);
      for (let r = 0; r < rows; r++) {
        const line = grid[r] ?? [];
        for (let c = 0; c < cols; c++) {
          const cell = line[c];
          const x = LABEL_W + c;
          const onCursor = x === cx;
          api.cell(
            x,
            top + r,
            cell?.ch ?? " ",
            cell?.fg ?? theme.text,
            onCursor ? theme.border : theme.bg,
          );
        }
      }
      // Label column: series name, then the value under the cursor.
      const name = SERIES_KEYS.find(([k]) => k === g.key)?.[2] ?? g.key;
      api.text(0, top, name.padEnd(LABEL_W - 1), theme.dim, theme.bg);
      if (sh && rows > 1) {
        let x = 0;
        for (const [text, color] of g.label(sh)) {
          api.text(x, top + 1, text, hex(color), theme.bg);
          x += [...text].length;
        }
      } else if (sh) {
        const [first] = g.label(sh);
        if (first)
          api.text(
            Math.max(0, LABEL_W - 1 - first[0].length),
            top,
            first[0],
            hex(first[1]),
            theme.bg,
          );
      }
    }
    // Time axis: hours every 6h, day names at midnight.
    const axisY = h - 1;
    for (let x = 0; x < w; x++) api.cell(x, axisY, " ", theme.dim, theme.bg);
    let lastEnd = LABEL_W - 1;
    hs.forEach((p, i) => {
      const local = new Date(p.time).toLocaleString("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: tz(),
      });
      const hr = Number(local) % 24;
      if (hr % 6 !== 0) return;
      const x = LABEL_W + colFor(i, cols);
      const label =
        hr === 0
          ? new Date(p.time).toLocaleDateString("en-US", { weekday: "short", timeZone: tz() })
          : shortHour(p.time, tz());
      if (x <= lastEnd) return;
      api.text(x, axisY, label, hr === 0 ? theme.text : theme.dim, theme.bg);
      lastEnd = x + label.length;
    });
    api.cell(cx, axisY, "▲", theme.accent, theme.bg);
  };

  const pick = (ev: MouseEvent) => {
    if (!canvas) return;
    const cols = Math.max(4, canvas.width - LABEL_W);
    const rel = ev.x - canvas.x - LABEL_W;
    if (rel < 0) return;
    const n = hours().length;
    props.setState(
      "hourCursor",
      Math.max(0, Math.min(n - 1, Math.round((rel / Math.max(1, cols - 1)) * (n - 1)))),
    );
  };

  const readout = () => {
    const h = sel();
    if (!h) return "";
    const day = new Date(h.time).toLocaleDateString("en-US", { weekday: "short", timeZone: tz() });
    return `${day} ${shortHour(h.time, tz())}`;
  };

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={T.border}
      title=" next 48 hours "
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none" flexShrink={0}>
        <span style={{ fg: T.accent }}>◀ {readout()} ▶</span>
        <span style={{ fg: T.dim }}>{"   "}</span>
        <For each={SERIES_KEYS}>
          {([k, key, label]) => (
            <span style={{ fg: props.state.hourSeries[k] ? T.text : T.faint }}>
              {`${key} ${label}  `}
            </span>
          )}
        </For>
      </text>
      <cell_canvas
        ref={(r: CellCanvas) => {
          canvas = r;
        }}
        height={chartRows()}
        flexShrink={0}
        draw={draw}
        onMouseDown={pick}
        onMouseDrag={pick}
      />
      <text fg={T.dim} wrapMode="none" flexShrink={0}>
        {"time      sky  temp  feels  rain   precip    wind           humidity  UV"}
      </text>
      <scrollbox
        flexGrow={1}
        ref={(r: ScrollBoxRenderable) => {
          table = r;
        }}
      >
        <For each={hours()}>
          {(h, i) => {
            const pp = h.precipitationProbability ?? 0;
            const day = new Date(h.time).toLocaleDateString("en-US", {
              weekday: "short",
              timeZone: tz(),
            });
            const bg = () => (i() === cursor() ? T.border : T.bg);
            return (
              <text wrapMode="none" bg={bg()} onMouseDown={() => props.setState("hourCursor", i())}>
                <span style={{ fg: T.dim, bg: bg() }}>
                  {`${day} ${shortHour(h.time, tz())}`.padEnd(10)}
                </span>
                <span style={{ fg: T.accent, bg: bg() }}>
                  {`${conditionGlyph(h.condition, h.isDay)}`.padEnd(4)}{" "}
                </span>
                <span style={{ fg: tcolor(h.temperature), bg: bg() }}>
                  {temp(h.temperature, u()).padStart(5)}{" "}
                </span>
                <span style={{ fg: tcolor(h.feelsLike ?? h.temperature), bg: bg() }}>
                  {temp(h.feelsLike ?? h.temperature, u()).padStart(6)}{" "}
                </span>
                <span style={{ fg: hexOf(precipScale(pp)), bg: bg() }}>
                  {`${Math.round(pp)}%`.padStart(5)} {"█".repeat(Math.round(pp / 20)).padEnd(5)}
                </span>
                <span style={{ fg: T.dim, bg: bg() }}>
                  {precip(h.precipitation, u()).padStart(8)}{" "}
                </span>
                <span style={{ fg: T.text, bg: bg() }}>
                  {`${windArrow(h.windDirection)} ${speed(h.windSpeed, u())}`.padEnd(14)}
                </span>
                <span style={{ fg: T.dim, bg: bg() }}>{`${h.humidity ?? "--"}%`.padStart(4)}</span>
                <span style={{ fg: hexOf(uvScale(h.uvIndex ?? 0)), bg: bg() }}>
                  {`${Math.round(h.uvIndex ?? 0)}`.padStart(8)}
                </span>
              </text>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}
