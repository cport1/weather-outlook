import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type {
  Climate,
  Marine,
  ModelComparison,
  Nws,
  NwsGridExtras,
  NwsObservation,
} from "../../domain/details.ts";
import type { AirQuality, Report } from "../../domain/types.ts";

type Confidence = NonNullable<ModelComparison["confidence"]>;
type Waves = NonNullable<Marine["waves"]>;
type Buoy = NonNullable<Marine["buoy"]>;
type Tides = NonNullable<Marine["tides"]>;

import { fmtMonthDay } from "../../providers/climate.ts";
import { reflow } from "../../providers/nws-forecast.ts";
import { lineChart } from "../../render/charts.ts";
import { multiLineChart, seriesRange } from "../../render/charts-multi.ts";
import { aqiScale, hex, type RGB, temperatureScale } from "../../render/color.ts";
import {
  anomalyScale,
  CONFIDENCE_COLOR,
  HEAT_RISK,
  modelColor,
  nextTides,
} from "../../render/details.ts";
import { compass, precip, pressure, speed, temp, windArrow } from "../../render/units.ts";
import { height, ordinal, tempDelta, wordWrap } from "../../render/units-more.ts";
import type { DrawApi } from "../cell-canvas.ts";
import { hexOf, tcolor } from "../format.ts";
import { scrollbarGutter } from "../scroll.ts";
import type { AppState } from "../store.ts";
import { T, theme } from "../theme.ts";

/**
 * "Details" view: NWS text products, model comparison, marine, air quality
 * and climate context, as sub-panels switched with ←/→ (or [ ]).
 */

type PanelId = "nws" | "models" | "marine" | "air" | "climate";
const PANEL_LABEL: Record<PanelId, string> = {
  nws: "NWS",
  models: "Models",
  marine: "Marine",
  air: "Air",
  climate: "Climate",
};

const hx = hexOf;
const BAND = hex("#1c2a3a");

function fmtTime(iso: string | undefined, tz?: string, minutes = true): string {
  if (!iso) return "--";
  return new Date(iso)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: minutes ? "2-digit" : undefined,
      timeZone: tz,
    })
    .replace(" ", "")
    .toLowerCase();
}

function fmtDay(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
}

/** True on the hour when the local hour is a multiple of `every` (0, 6, 12, 18 for 6). */
function onLocalHour(iso: string, tz: string | undefined, every: number): boolean {
  const d = new Date(iso);
  if (d.getUTCMinutes() !== 0) return false;
  const h = Number(d.toLocaleString("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }));
  return h % every === 0;
}

/** Labels for the times picked by `pick`, placed proportionally across `cols`. */
function timeAxis(
  times: readonly string[],
  cols: number,
  pick: (iso: string, i: number) => boolean,
  fmt: (iso: string) => string,
): string {
  const row = Array.from({ length: cols }, () => " ");
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t || !pick(t, i)) continue;
    const col = Math.round((i / Math.max(1, times.length - 1)) * (cols - 1));
    const label = fmt(t);
    if (col + label.length > cols) continue;
    [...label].forEach((ch, j) => {
      row[col + j] = ch;
    });
  }
  return row.join("");
}

/** A canvas that re-renders a chart at whatever size layout gives it, with an optional time axis. */
function Chart(props: {
  /** Fixed height; omit to fill the parent. */
  rows?: number;
  build: (cols: number, rows: number) => ReturnType<typeof lineChart>;
  axis?: (cols: number) => string;
}) {
  const draw = (api: DrawApi, w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    const axis = props.axis && h > 2 ? props.axis(w) : undefined;
    api.grid(props.build(w, axis ? h - 1 : h));
    if (axis) api.text(0, h - 1, axis, theme.dim);
  };
  return props.rows ? (
    <cell_canvas height={props.rows} flexShrink={0} draw={draw} />
  ) : (
    <cell_canvas flexGrow={1} draw={draw} />
  );
}

function Panel(props: {
  title: string;
  children: JSX.Element;
  flexGrow?: number;
  width?: number;
  /** Fixed content rows (plus 2 for the border); the panel then never shrinks. */
  rows?: number;
  color?: string;
}) {
  return (
    <box
      flexDirection="column"
      flexGrow={props.width || props.rows ? 0 : (props.flexGrow ?? 1)}
      flexShrink={props.rows ? 0 : 1}
      height={props.rows ? props.rows + 2 : undefined}
      width={props.width}
      border
      borderStyle="rounded"
      borderColor={props.color ?? T.border}
      title={` ${props.title} `}
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  );
}

function Empty(props: { text: string }) {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={T.dim}>{props.text}</text>
    </box>
  );
}

// ─── NWS ───────────────────────────────────────────────────────────────────

function NwsPanel(props: {
  state: AppState;
  report: Report;
  scroll: (s: ScrollBoxRenderable) => void;
}) {
  const nws = () => props.report.nws;
  const [wrapWidth, setWrapWidth] = createSignal(80);
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  return (
    <Show
      when={nws()}
      fallback={<Empty text="NWS products are only available for US locations." />}
    >
      {(n: () => Nws) => (
        <box flexDirection="row" flexGrow={1} gap={1}>
          <box flexDirection="column" width="45%">
            <Show when={n().observation}>
              {(o: () => NwsObservation) => (
                <Panel title={`observed · ${o().station}`} rows={2}>
                  <text wrapMode="none">
                    <span style={{ fg: tcolor(o().temperature ?? 0) }}>
                      {o().temperature !== undefined ? temp(o().temperature as number, u()) : "--"}
                    </span>
                    <span style={{ fg: T.text }}> {o().description ?? ""}</span>
                    <span style={{ fg: T.dim }}> at {fmtTime(o().time, tz())}</span>
                  </text>
                  <text wrapMode="none" fg={T.dim}>
                    {`${windArrow(o().windDirection)} ${speed(o().windSpeed, u())}${o().windGust ? ` gusts ${speed(o().windGust, u())}` : ""} · ${Math.round(o().humidity ?? 0)}% · ${pressure(o().pressure, u())}`}
                  </text>
                </Panel>
              )}
            </Show>
            <Show when={n().extras}>
              {(x: () => NwsGridExtras) => (
                <text wrapMode="none" height={1} flexShrink={0}>
                  <Show when={x().heatRiskMax !== undefined}>
                    <span style={{ fg: T.dim }}> HeatRisk </span>
                    <span style={{ fg: (x().heatRiskMax ?? 0) >= 2 ? T.warn : T.text }}>
                      {HEAT_RISK[x().heatRiskMax ?? 0] ?? "?"}
                    </span>
                  </Show>
                  <Show when={x().lightningMax}>
                    <span style={{ fg: T.dim }}> · lightning </span>
                    <span style={{ fg: T.warn }}>LAL {x().lightningMax}</span>
                  </Show>
                  <Show when={(x().snowfallTotal ?? 0) > 0}>
                    <span style={{ fg: T.dim }}> · snow 24h </span>
                    <span style={{ fg: T.accent }}>{precip(x().snowfall24h, u())}</span>
                  </Show>
                </text>
              )}
            </Show>
            <Panel title={`forecast · ${n().office}`}>
              <scrollbox flexGrow={1} scrollX={false} contentOptions={scrollbarGutter()}>
                <For each={n().periods}>
                  {(p) => (
                    <box flexDirection="column" paddingBottom={1}>
                      <text wrapMode="none">
                        <span style={{ fg: T.accent }}>{p.name}</span>
                        <Show when={p.temperature !== undefined}>
                          <span style={{ fg: tcolor(p.temperature ?? 0) }}>
                            {"  "}
                            {temp(p.temperature ?? Number.NaN, u())}
                          </span>
                        </Show>
                        <span style={{ fg: T.dim }}> {p.shortForecast}</span>
                      </text>
                      <text fg={T.text}>{p.detailedForecast}</text>
                    </box>
                  )}
                </For>
              </scrollbox>
            </Panel>
          </box>
          <Panel
            title={
              n().discussion
                ? `area forecast discussion · issued ${fmtTime(n().discussion?.issued, tz())} · ↑↓ scroll`
                : "area forecast discussion"
            }
          >
            <scrollbox
              flexGrow={1}
              scrollX={false}
              ref={(r: ScrollBoxRenderable) => {
                props.scroll(r);
                // Wrap to the measured viewport ourselves: OpenTUI's text measure lets
                // long paragraphs overflow by a column, which the scrollbar then hides.
                // Scrollbox width minus the scrollbar and a one-column margin.
                const sync = () => r.width > 12 && setWrapWidth(r.width - 2);
                r.onSizeChange = sync;
                sync();
              }}
            >
              <text fg={T.text} wrapMode="none">
                {wordWrap(reflow(n().discussion?.text ?? "Not available."), wrapWidth())}
              </text>
            </scrollbox>
          </Panel>
        </box>
      )}
    </Show>
  );
}

// ─── Models ────────────────────────────────────────────────────────────────

function dailyHighs(m: ModelComparison, values: ReadonlyArray<number | null>): Map<string, number> {
  const out = new Map<string, number>();
  m.times.forEach((t, i) => {
    const v = values[i];
    if (typeof v !== "number") return;
    const d = t.slice(0, 10);
    out.set(d, Math.max(out.get(d) ?? Number.NEGATIVE_INFINITY, v));
  });
  return out;
}

function ModelsPanel(props: { state: AppState; report: Report }) {
  const m = () => props.report.models;
  const u = () => props.state.units;
  // Show from the current hour onward.
  const start = createMemo(() => {
    const mm = m();
    if (!mm) return 0;
    const now = Date.now();
    return Math.max(0, mm.times.findIndex((t) => Date.parse(t) > now) - 1);
  });
  const sliced = createMemo(() => {
    const mm = m();
    if (!mm) return undefined;
    const s = start();
    return {
      series: mm.models.map((x) => ({ values: x.temperature.slice(s), color: modelColor(x.id) })),
      band: mm.ensemble
        ? { min: mm.ensemble.min.slice(s), max: mm.ensemble.max.slice(s), color: BAND }
        : undefined,
      times: mm.times.slice(s),
    };
  });
  const range = () => {
    const s = sliced();
    return s ? seriesRange(s.series, s.band) : { min: 0, max: 1 };
  };
  const days = createMemo(() => {
    const mm = m();
    if (!mm) return [];
    const today = mm.times[start()]?.slice(0, 10) ?? "";
    return [...new Set(mm.times.map((t) => t.slice(0, 10)))].filter((d) => d >= today).slice(0, 7);
  });
  return (
    <Show when={m()} fallback={<Empty text="Model data unavailable." />}>
      {(mm: () => ModelComparison) => (
        <box flexDirection="column" flexGrow={1}>
          <Panel title="temperature by model · shaded = ECMWF ensemble min–max">
            <box flexDirection="row" flexGrow={1}>
              <box width={5} flexDirection="column" justifyContent="space-between">
                <text fg={T.dim}>{temp(range().max, u(), false)}</text>
                <text fg={T.dim}>{temp(range().min, u(), false)}</text>
              </box>
              <Chart
                build={(cols, rows) => {
                  const s = sliced();
                  return s
                    ? multiLineChart(s.series, cols, rows, { band: s.band, range: range() })
                    : [];
                }}
                axis={(cols) =>
                  // Label each local midnight (times carry the location's offset).
                  timeAxis(
                    sliced()?.times ?? [],
                    cols,
                    (t) => onLocalHour(t, props.state.location.timezone, 24),
                    (t) => `│${fmtDay(t, props.state.location.timezone)}`,
                  )
                }
              />
            </box>
          </Panel>
          <box flexDirection="row" gap={1} height={mm().models.length + 4}>
            <Panel title="daily highs">
              <text wrapMode="none" fg={T.dim}>
                {"".padEnd(12)}
                {days()
                  .map((d) => fmtDay(`${d}T12:00:00Z`, "UTC").padStart(6))
                  .join("")}
              </text>
              <For each={mm().models}>
                {(x) => {
                  const highs = dailyHighs(mm(), x.temperature);
                  return (
                    <text wrapMode="none">
                      <span style={{ fg: hx(modelColor(x.id)) }}>{`━ ${x.label}`.padEnd(12)}</span>
                      <For each={days()}>
                        {(d) => {
                          const v = highs.get(d);
                          return (
                            <span style={{ fg: v !== undefined ? tcolor(v) : T.faint }}>
                              {(v !== undefined ? temp(v, u(), false) : "·").padStart(6)}
                            </span>
                          );
                        }}
                      </For>
                    </text>
                  );
                }}
              </For>
            </Panel>
            <Show when={mm().confidence}>
              {(c: () => Confidence) => (
                <Panel
                  title="forecast confidence"
                  width={34}
                  color={hx(CONFIDENCE_COLOR[c().label])}
                >
                  <text wrapMode="none">
                    <span style={{ fg: hx(CONFIDENCE_COLOR[c().label]) }}>
                      {`${c().score}% · ${c().label}`}
                    </span>
                  </text>
                  <text wrapMode="none" fg={T.dim}>
                    {`next ${c().hours}h · ensemble σ ${tempDelta(c().spread, u()).replace(/^[+±]/, "")}`}
                  </text>
                  <Show when={c().modelSpread !== undefined}>
                    <text wrapMode="none" fg={T.dim}>
                      {`models differ by ~${tempDelta(c().modelSpread, u()).replace(/^[+±]/, "")}`}
                    </text>
                  </Show>
                  <Show when={mm().ensemble}>
                    <text
                      wrapMode="none"
                      fg={T.dim}
                    >{`${mm().ensemble?.members} ensemble members`}</text>
                  </Show>
                </Panel>
              )}
            </Show>
          </box>
        </box>
      )}
    </Show>
  );
}

// ─── Marine ────────────────────────────────────────────────────────────────

function MarinePanel(props: { state: AppState; report: Report }) {
  const mr = () => props.report.marine;
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  const tideCurve = createMemo(() => {
    const t = mr()?.tides;
    if (!t) return [];
    const now = Date.now() - 3 * 3_600_000;
    return t.curve.filter((p) => Date.parse(p.time) >= now).slice(0, 48);
  });
  const waves = createMemo(() => {
    const w = mr()?.waves;
    if (!w) return [];
    const now = Date.now() - 3_600_000;
    return w.hourly.filter((p) => Date.parse(p.time) >= now).slice(0, 48);
  });
  const tideColor = () => hex("#4dd0e1");
  return (
    <Show when={mr()} fallback={<Empty text="No marine data: this location isn't on the coast." />}>
      {(m: () => Marine) => (
        <box flexDirection="column" flexGrow={1}>
          <box flexDirection="row" gap={1} flexGrow={1}>
            <Panel title="waves · next 48h (open-meteo marine)">
              <Show when={m().waves}>
                {(w: () => Waves) => (
                  <>
                    <text wrapMode="none">
                      <span style={{ fg: T.accent }}>{height(w().current.height, u())}</span>
                      <span style={{ fg: T.dim }}>
                        {w().current.period ? ` · ${Math.round(w().current.period ?? 0)} s` : ""}
                        {w().current.direction !== undefined
                          ? ` · from ${compass(w().current.direction)} ${windArrow(w().current.direction)}`
                          : ""}
                      </span>
                      <Show when={w().current.seaSurfaceTemperature !== undefined}>
                        <span style={{ fg: T.dim }}> · sea </span>
                        <span style={{ fg: tcolor(w().current.seaSurfaceTemperature ?? 0) }}>
                          {temp(w().current.seaSurfaceTemperature ?? Number.NaN, u())}
                        </span>
                      </Show>
                    </text>
                    <Chart
                      build={(cols, rows) =>
                        lineChart(
                          waves().map((p) => p.height ?? Number.NaN),
                          cols,
                          rows,
                          () => hex("#29b6f6"),
                          { min: 0, max: Math.max(1, ...waves().map((p) => p.height ?? 0)) * 1.1 },
                        )
                      }
                      axis={(cols) =>
                        timeAxis(
                          waves().map((p) => p.time),
                          cols,
                          (t) => onLocalHour(t, tz(), 6),
                          (t) => `│${fmtTime(t, tz(), false)}`,
                        )
                      }
                    />
                  </>
                )}
              </Show>
            </Panel>
            <Show when={m().buoy}>
              {(b: () => Buoy) => (
                <Panel title={`buoy ${b().id} · ${Math.round(b().distanceKm)} km`} width={34}>
                  <text fg={T.dim}>observed {fmtTime(b().time, tz())}</text>
                  <Show when={b().waveHeight !== undefined}>
                    <text>
                      waves {height(b().waveHeight, u())}
                      {b().dominantPeriod ? ` @ ${b().dominantPeriod} s` : ""}
                    </text>
                  </Show>
                  <Show when={b().windSpeed !== undefined}>
                    <text>
                      wind {windArrow(b().windDirection)} {speed(b().windSpeed, u())}
                      {b().windGust ? ` g ${speed(b().windGust, u())}` : ""}
                    </text>
                  </Show>
                  <Show when={b().waterTemperature !== undefined}>
                    <text>water {temp(b().waterTemperature ?? Number.NaN, u())}</text>
                  </Show>
                  <Show when={b().airTemperature !== undefined}>
                    <text>air {temp(b().airTemperature ?? Number.NaN, u())}</text>
                  </Show>
                  <Show when={b().pressure !== undefined}>
                    <text>{pressure(b().pressure, u())}</text>
                  </Show>
                </Panel>
              )}
            </Show>
          </box>
          <Show when={m().tides}>
            {(t: () => Tides) => (
              <Panel
                title={`tides · ${t().station.name} (${Math.round(t().station.distanceKm)} km, NOAA CO-OPS)`}
              >
                <text wrapMode="none">
                  <For each={nextTides(t().events, Date.now(), 4)}>
                    {(e) => (
                      <>
                        <span style={{ fg: e.type === "high" ? T.accent : T.dim }}>
                          {e.type === "high" ? "▲ high " : "▼ low "}
                        </span>
                        <span style={{ fg: T.text }}>
                          {`${fmtDay(e.time, tz())} ${fmtTime(e.time, tz())} ${height(e.height, u())}   `}
                        </span>
                      </>
                    )}
                  </For>
                </text>
                <Chart
                  build={(cols, rows) =>
                    lineChart(
                      tideCurve().map((p) => p.height),
                      cols,
                      rows,
                      tideColor,
                    )
                  }
                  axis={(cols) =>
                    timeAxis(
                      tideCurve().map((p) => p.time),
                      cols,
                      (t) => onLocalHour(t, tz(), 6),
                      (t) => `│${fmtTime(t, tz(), false)}`,
                    )
                  }
                />
              </Panel>
            )}
          </Show>
        </box>
      )}
    </Show>
  );
}

// ─── Air ───────────────────────────────────────────────────────────────────

const POLLEN_MAX: Record<string, number> = {
  alder: 100,
  birch: 100,
  grass: 50,
  mugwort: 50,
  olive: 100,
  ragweed: 50,
};

function AirPanel(props: { state: AppState; report: Report }) {
  const aq = () => props.report.airQuality;
  const tz = () => props.state.location.timezone;
  const hours = createMemo(() => {
    const h = aq()?.hourly ?? [];
    const now = Date.now() - 3_600_000;
    return h.filter((p) => Date.parse(p.time) >= now).slice(0, 72);
  });
  const peak = () => hours().reduce<number>((a, h) => Math.max(a, h.usAqi ?? 0), 0);
  return (
    <Show when={aq()} fallback={<Empty text="Air quality unavailable." />}>
      {(a: () => AirQuality) => (
        <box flexDirection="column" flexGrow={1}>
          <Panel title="US AQI · next 72h">
            <text wrapMode="none">
              <span style={{ fg: T.dim }}>now </span>
              <span style={{ fg: hx(aqiScale(a().usAqi ?? 0)) }}>
                {String(Math.round(a().usAqi ?? 0))}
              </span>
              <span style={{ fg: T.dim }}> · peak </span>
              <span style={{ fg: hx(aqiScale(peak())) }}>{String(Math.round(peak()))}</span>
              <span style={{ fg: T.dim }}>
                {`  ·  PM2.5 ${a().pm2_5 ?? "--"}  PM10 ${a().pm10 ?? "--"}  O₃ ${a().ozone ?? "--"}  NO₂ ${a().no2 ?? "--"} µg/m³`}
              </span>
              <Show when={a().europeanAqi !== undefined}>
                <span style={{ fg: T.dim }}>{`  ·  EAQI ${Math.round(a().europeanAqi ?? 0)}`}</span>
              </Show>
            </text>
            <Chart
              build={(cols, rows) =>
                lineChart(
                  hours().map((h) => h.usAqi ?? Number.NaN),
                  cols,
                  rows,
                  (v) => aqiScale(v),
                  { min: 0, max: Math.max(100, peak() * 1.1) },
                )
              }
              axis={(cols) =>
                timeAxis(
                  hours().map((h) => h.time),
                  cols,
                  (t) => onLocalHour(t, tz(), 12),
                  (t) => `│${fmtDay(t, tz())} ${fmtTime(t, tz(), false)}`,
                )
              }
            />
          </Panel>
          <box flexDirection="row" gap={1}>
            <Show when={a().pollen}>
              {(p: () => Record<string, number>) => (
                <Panel title="pollen (grains/m³)">
                  <For each={Object.entries(p())}>
                    {([name, v]) => {
                      const frac = Math.min(1, v / (POLLEN_MAX[name] ?? 100));
                      const color = frac > 0.66 ? T.danger : frac > 0.33 ? T.warn : T.ok;
                      return (
                        <text wrapMode="none">
                          <span style={{ fg: T.dim }}>{name.padEnd(9)}</span>
                          <span style={{ fg: color }}>
                            {"█".repeat(Math.max(1, Math.round(frac * 20)))}
                          </span>
                          <span style={{ fg: T.dim }}> {v}</span>
                        </text>
                      );
                    }}
                  </For>
                </Panel>
              )}
            </Show>
            <For each={a().stations ?? []}>
              {(s) => (
                <Panel
                  title={`OpenAQ · ${s.name}${s.distanceKm !== undefined ? ` (${s.distanceKm} km)` : ""}`}
                >
                  <For each={Object.entries(s.readings)}>
                    {([k, r]) => (
                      <text wrapMode="none">
                        <span style={{ fg: T.dim }}>{k.padEnd(6)}</span>
                        <span style={{ fg: T.text }}>{`${r.value} ${r.units}`}</span>
                      </text>
                    )}
                  </For>
                  <text fg={T.dim}>{s.time ? `as of ${fmtTime(s.time, tz())}` : ""}</text>
                </Panel>
              )}
            </For>
          </box>
        </box>
      )}
    </Show>
  );
}

// ─── Climate ───────────────────────────────────────────────────────────────

function ClimatePanel(props: { state: AppState; report: Report }) {
  const cl = () => props.report.climate;
  const u = () => props.state.units;
  const fc = (date: string) => props.report.forecast?.daily.find((d) => d.date === date);
  return (
    <Show when={cl()} fallback={<Empty text="Climate history unavailable." />}>
      {(c: () => Climate) => (
        <Panel title={`vs ${c().startYear}–${c().endYear} normals (ERA5 archive, ±3 days)`}>
          <Show when={c().fact}>
            <text fg={T.warn}>★ {c().fact}</text>
          </Show>
          <text wrapMode="none" fg={T.dim}>
            {c().recordHigh
              ? `record high for ${fmtMonthDay(c().days[0]?.date ?? "")}: ${temp(c().recordHigh?.value ?? Number.NaN, u())} (${c().recordHigh?.year})`
              : ""}
            {c().recordLow
              ? `   record low: ${temp(c().recordLow?.value ?? Number.NaN, u())} (${c().recordLow?.year})`
              : ""}
          </text>
          <text> </text>
          <text wrapMode="none" fg={T.dim}>
            {"day      high   normal   anomaly            pctl    low   normal   anomaly  pctl"}
          </text>
          <For each={c().days}>
            {(d) => {
              const f = fc(d.date);
              const bar = (a: number | undefined) => {
                const n = Math.max(-8, Math.min(8, Math.round(a ?? 0)));
                return n >= 0
                  ? `${" ".repeat(8)}│${"█".repeat(n).padEnd(8)}`
                  : `${" ".repeat(8 + n)}${"█".repeat(-n)}│${" ".repeat(8)}`;
              };
              return (
                <text wrapMode="none">
                  <span style={{ fg: T.text }}>{fmtMonthDay(d.date).padEnd(8)}</span>
                  <span style={{ fg: tcolor(f?.tempMax ?? d.normalHigh) }}>
                    {(f ? temp(f.tempMax, u(), false) : "--").padStart(5)}
                  </span>
                  <span style={{ fg: T.dim }}>{temp(d.normalHigh, u(), false).padStart(8)}</span>
                  <span style={{ fg: hx(anomalyScale(d.highAnomaly ?? 0)) }}>
                    {tempDelta(d.highAnomaly, u()).padStart(6)} {bar(d.highAnomaly)}
                  </span>
                  <span style={{ fg: T.dim }}>
                    {(d.highPercentile !== undefined ? ordinal(d.highPercentile) : "").padStart(6)}
                  </span>
                  <span style={{ fg: tcolor(f?.tempMin ?? d.normalLow) }}>
                    {(f ? temp(f.tempMin, u(), false) : "--").padStart(7)}
                  </span>
                  <span style={{ fg: T.dim }}>{temp(d.normalLow, u(), false).padStart(8)}</span>
                  <span style={{ fg: hx(anomalyScale(d.lowAnomaly ?? 0)) }}>
                    {tempDelta(d.lowAnomaly, u()).padStart(9)}
                  </span>
                  <span style={{ fg: T.dim }}>
                    {(d.lowPercentile !== undefined ? ordinal(d.lowPercentile) : "").padStart(6)}
                  </span>
                </text>
              );
            }}
          </For>
        </Panel>
      )}
    </Show>
  );
}

// ─── View ──────────────────────────────────────────────────────────────────

export function DetailsView(props: { state: AppState; report: Report }) {
  const panels = createMemo<PanelId[]>(() => {
    const r = props.report;
    const out: PanelId[] = [];
    if (r.nws) out.push("nws");
    out.push("models");
    if (r.marine) out.push("marine");
    out.push("air", "climate");
    return out;
  });
  const [index, setIndex] = createSignal(0);
  const current = () => panels()[Math.min(index(), panels().length - 1)] ?? "models";
  let afd: ScrollBoxRenderable | undefined;

  useKeyboard((key) => {
    if (props.state.view !== "details") return;
    const n = key.name;
    const len = panels().length;
    if (n === "right" || n === "]" || n === "l") setIndex((i) => (i + 1) % len);
    if (n === "left" || n === "[" || n === "h") setIndex((i) => (i - 1 + len) % len);
    if (current() === "nws" && afd) {
      if (n === "down" || n === "j") afd.scrollBy(2);
      if (n === "up" || n === "k") afd.scrollBy(-2);
      if (n === "pagedown") afd.scrollBy(20);
      if (n === "pageup") afd.scrollBy(-20);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text wrapMode="none" height={1} flexShrink={0}>
        <For each={panels()}>
          {(p) => (
            <span
              style={{
                fg: current() === p ? T.bg : T.dim,
                bg: current() === p ? T.accent2 : T.bg,
              }}
            >
              {` ${PANEL_LABEL[p]} `}
            </span>
          )}
        </For>
        <span style={{ fg: T.faint }}>{"   ←/→ switch panel"}</span>
      </text>
      <Switch>
        <Match when={current() === "nws"}>
          <NwsPanel state={props.state} report={props.report} scroll={(s) => (afd = s)} />
        </Match>
        <Match when={current() === "models"}>
          <ModelsPanel state={props.state} report={props.report} />
        </Match>
        <Match when={current() === "marine"}>
          <MarinePanel state={props.state} report={props.report} />
        </Match>
        <Match when={current() === "air"}>
          <AirPanel state={props.state} report={props.report} />
        </Match>
        <Match when={current() === "climate"}>
          <ClimatePanel state={props.state} report={props.report} />
        </Match>
      </Switch>
    </box>
  );
}
