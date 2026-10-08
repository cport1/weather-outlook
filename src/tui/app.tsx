import { extend, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { moonGlyph } from "../domain/astronomy.ts";
import { CONDITION_LABEL, conditionGlyph, precipKind } from "../domain/conditions.ts";
import type {
  Alert,
  Astronomy,
  Condition,
  DailyPoint,
  Forecast,
  Report,
  Severity,
} from "../domain/types.ts";
import { conditionArt } from "../render/art.ts";
import type { Cell } from "../render/canvas.ts";
import { lineChart, sparkline } from "../render/charts.ts";
import { aqiScale, hex, type RGB, scale, temperatureScale } from "../render/color.ts";
import { type FxKind, WeatherFx } from "../render/fx.ts";
import {
  clockTime,
  compass,
  distance,
  precip,
  pressure,
  speed,
  temp,
  windArrow,
} from "../render/units.ts";
import type { HttpClient } from "../util/http.ts";
import { CellCanvas, type DrawApi } from "./cell-canvas.ts";
import { type AppState, VIEW_LABEL, VIEWS } from "./store.ts";
import { T, theme, toHexStr } from "./theme.ts";
import { HazardsView } from "./views/hazards.tsx";
import { MapView } from "./views/map.tsx";
import { type RadarControls, RadarView } from "./views/radar.tsx";

extend({ cell_canvas: CellCanvas });

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    cell_canvas: typeof CellCanvas;
  }
}

const SEVERITY_COLOR: Record<Severity, RGB> = {
  extreme: hex("#ff1744"),
  severe: hex("#ff6d00"),
  moderate: hex("#ffd600"),
  minor: hex("#64b5f6"),
  unknown: hex("#b0bec5"),
};
const precipScale = scale([
  [0, "#2b3640"],
  [20, "#4f7cac"],
  [60, "#29b6f6"],
  [100, "#00e5ff"],
]);
const hexOf = (c: RGB) => toHexStr(c);
const tcolor = (c: number) => hexOf(temperatureScale(c));

interface Props {
  http: HttpClient;
  state: AppState;
  setState: SetStoreFunction<AppState>;
  refresh: () => void;
  quit: () => void;
}

function fmtTime(iso: string | undefined, tz?: string, withMinutes = true): string {
  if (!iso) return "--";
  return clockTime(iso, tz, withMinutes);
}

function sceneKind(cond: Condition, isDay: boolean): FxKind {
  const k = precipKind(cond);
  if (k === "rain" || k === "snow" || k === "storm" || k === "fog") return k;
  if (cond === "clear" || cond === "mostly-clear") return isDay ? "clear-day" : "clear-night";
  return "none";
}

const SIMULATE: Record<string, Condition> = {
  rain: "rain",
  snow: "snow",
  storm: "thunderstorm",
  thunder: "thunderstorm",
  fog: "fog",
  clear: "clear",
  cloudy: "cloudy",
};

// ─── Header / footer ───────────────────────────────────────────────────────

function Header(props: { state: AppState }) {
  const loc = () => props.state.location;
  const place = () => [loc().name, loc().region, loc().countryCode].filter(Boolean).join(", ");
  const clock = () => clockTime(new Date(), loc().timezone);
  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1} backgroundColor={T.panel}>
      <text wrapMode="none">
        <span style={{ fg: T.accent }}>◆ weather-outlook </span>
        <span style={{ fg: T.text }}>{place()}</span>
        <span style={{ fg: T.dim }}> · {clock()}</span>
      </text>
      <box flexGrow={1} />
      <text wrapMode="none">
        <For each={[...VIEWS]}>
          {(v, i) => (
            <span
              style={{
                fg: props.state.view === v ? T.bg : T.dim,
                bg: props.state.view === v ? T.accent : T.panel,
              }}
            >
              {` ${i() + 1} ${VIEW_LABEL[v]}${v === "alerts" && props.state.report?.alerts.length ? ` (${props.state.report.alerts.length})` : ""} `}
            </span>
          )}
        </For>
      </text>
    </box>
  );
}

function Footer(props: { state: AppState }) {
  const status = () => {
    if (props.state.loading) return "refreshing…";
    if (props.state.error) return `error: ${props.state.error}`;
    if (!props.state.lastUpdated) return "";
    const mins = Math.round((Date.now() - props.state.lastUpdated) / 60_000);
    return mins < 1 ? "updated just now" : `updated ${mins}m ago`;
  };
  const hints = () =>
    props.state.view === "map"
      ? "←↑↓→ pan  +/- zoom  c center  0 reset  S/F/H/Q/A layers"
      : props.state.view === "radar"
        ? "space play/pause  ,/. step  +/- zoom"
        : props.state.view === "alerts"
          ? "↑↓ select alert"
          : "tab/1-7 views";
  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1} backgroundColor={T.panel}>
      <text wrapMode="none">
        <span style={{ fg: T.dim }}>{hints()}</span>
        <span style={{ fg: T.faint }}> │ </span>
        <span style={{ fg: T.dim }}>u units r refresh ? help q quit</span>
      </text>
      <box flexGrow={1} />
      <text fg={props.state.error ? T.danger : T.dim}>{status()}</text>
    </box>
  );
}

// ─── Now view ──────────────────────────────────────────────────────────────

function Scene(props: {
  condition: Condition;
  isDay: boolean;
  precipRate: number;
  windKmh: number;
  motion: boolean;
}) {
  const fx = new WeatherFx(40, 12, sceneKind(props.condition, props.isDay));
  const draw = (api: DrawApi, w: number, h: number, dt: number) => {
    fx.kind = sceneKind(props.condition, props.isDay);
    fx.intensity = Math.min(1, props.precipRate / 6 + 0.3);
    fx.wind = Math.max(-12, Math.min(12, props.windKmh / 4));
    fx.resize(w, h);
    if (props.motion) fx.step(dt);
    // Sky gradient.
    const top = props.isDay ? hex("#16324f") : hex("#05070d");
    const bottom = props.isDay ? hex("#2b5876") : hex("#121a2b");
    const flash = fx.flashLevel;
    for (let y = 0; y < h; y++) {
      const t = y / Math.max(1, h - 1);
      const c: RGB = [
        top[0] + (bottom[0] - top[0]) * t + flash * 90,
        top[1] + (bottom[1] - top[1]) * t + flash * 90,
        top[2] + (bottom[2] - top[2]) * t + flash * 90,
      ].map((v) => Math.min(255, v)) as unknown as RGB;
      for (let x = 0; x < w; x++) api.cell(x, y, " ", undefined, c);
    }
    for (const c of fx.cells()) api.blend(c.x, c.y, c.ch, c.fg);
    // Condition art, centered.
    const art = conditionArt(props.condition, props.isDay);
    const ax = Math.floor((w - 13) / 2);
    const ay = Math.floor((h - art.length) / 2);
    art.forEach((runs, r) => {
      let x = ax;
      for (const [text, color] of runs) {
        for (const ch of text) {
          if (ch !== " ") api.blend(x, ay + r, ch, color ?? theme.text);
          x++;
        }
      }
    });
  };
  return <cell_canvas live={props.motion} flexGrow={1} height="100%" draw={draw} />;
}

function Metric(props: { label: string; value: string; color?: string }) {
  return (
    <text wrapMode="none">
      <span style={{ fg: T.dim }}>{props.label.padEnd(12)}</span>
      <span style={{ fg: props.color ?? T.text }}>{props.value}</span>
    </text>
  );
}

function ChartCanvas(props: { cells: () => Cell[][] }) {
  return <cell_canvas flexGrow={1} height="100%" draw={(api) => api.grid(props.cells())} />;
}

function NowView(props: { state: AppState; report: Report }) {
  const fc = () => props.report.forecast;
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  const cond = (): Condition => {
    const s = props.state.simulate;
    return (s && SIMULATE[s]) || fc()?.current.condition || "unknown";
  };
  const next24 = createMemo(() => {
    const f = fc();
    if (!f) return [];
    const now = Date.now();
    const i = Math.max(0, f.hourly.findIndex((h) => new Date(h.time).getTime() > now) - 1);
    return f.hourly.slice(i, i + 24);
  });
  const dims = useTerminalDimensions();
  const chartCells = createMemo(() => {
    const temps = next24().map((h) => h.temperature);
    return lineChart(temps, Math.max(20, dims().width - 12), 5, temperatureScale);
  });
  return (
    <Show when={fc()} fallback={<text fg={T.dim}>No forecast data.</text>}>
      {(f: () => Forecast) => {
        const c = () => f().current;
        const today = () => f().daily[0];
        return (
          <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" flexGrow={1} gap={1}>
              <box flexGrow={1} border borderStyle="rounded" borderColor={T.border} title=" sky ">
                <Scene
                  condition={cond()}
                  isDay={c().isDay}
                  precipRate={c().precipitation ?? 0}
                  windKmh={
                    (c().windSpeed ?? 0) *
                    (Math.sin(((c().windDirection ?? 270) * Math.PI) / 180) > 0 ? -1 : 1)
                  }
                  motion={props.state.motion}
                />
              </box>
              <box
                width={44}
                flexDirection="column"
                border
                borderStyle="rounded"
                borderColor={T.border}
                paddingLeft={1}
                title=" now "
              >
                <ascii_font
                  text={temp(c().temperature, u())}
                  font="block"
                  color={tcolor(c().temperature)}
                />
                <text fg={T.text}>
                  {CONDITION_LABEL[cond()]}
                  <span style={{ fg: T.dim }}> feels </span>
                  <span style={{ fg: tcolor(c().feelsLike ?? c().temperature) }}>
                    {temp(c().feelsLike ?? c().temperature, u())}
                  </span>
                </text>
                <Show when={today()}>
                  {(d: () => DailyPoint) => (
                    <text wrapMode="none">
                      <span style={{ fg: T.dim }}>high </span>
                      <span style={{ fg: tcolor(d().tempMax) }}>{temp(d().tempMax, u())}</span>
                      <span style={{ fg: T.dim }}> low </span>
                      <span style={{ fg: tcolor(d().tempMin) }}>{temp(d().tempMin, u())}</span>
                    </text>
                  )}
                </Show>
                <text> </text>
                <Metric
                  label="wind"
                  value={`${windArrow(c().windDirection)} ${speed(c().windSpeed, u())} ${compass(c().windDirection)}`}
                  color={T.accent}
                />
                <Metric label="gusts" value={speed(c().windGust, u())} />
                <Metric label="humidity" value={`${c().humidity ?? "--"}%`} />
                <Metric
                  label="dew point"
                  value={c().dewPoint !== undefined ? temp(c().dewPoint as number, u()) : "--"}
                />
                <Metric label="pressure" value={pressure(c().pressure, u())} />
                <Metric label="visibility" value={distance(c().visibility, u())} />
                <Metric label="cloud cover" value={`${c().cloudCover ?? "--"}%`} />
                <Metric label="UV index" value={String(Math.round(c().uvIndex ?? 0))} />
                <Show when={props.report.airQuality?.usAqi !== undefined}>
                  <Metric
                    label="air (AQI)"
                    value={String(Math.round(props.report.airQuality?.usAqi ?? 0))}
                    color={hexOf(aqiScale(props.report.airQuality?.usAqi ?? 0))}
                  />
                </Show>
                <Show when={props.report.astronomy}>
                  {(a: () => Astronomy) => (
                    <>
                      <Metric
                        label="sun"
                        value={`${fmtTime(a().sunrise, tz())} → ${fmtTime(a().sunset, tz())}`}
                        color={T.warn}
                      />
                      <Metric
                        label="moon"
                        value={`${moonGlyph(a().moonPhase)} ${a().moonPhaseName} ${Math.round(a().moonIllumination * 100)}%`}
                      />
                    </>
                  )}
                </Show>
              </box>
            </box>
            <box
              height={9}
              border
              borderStyle="rounded"
              borderColor={T.border}
              title=" next 24 hours "
              flexDirection="column"
              paddingLeft={1}
            >
              <box flexDirection="row" height={5}>
                <box width={5} flexDirection="column">
                  <text fg={T.dim}>
                    {temp(Math.max(...next24().map((h) => h.temperature)), u(), false)}
                  </text>
                  <text> </text>
                  <text> </text>
                  <text> </text>
                  <text fg={T.dim}>
                    {temp(Math.min(...next24().map((h) => h.temperature)), u(), false)}
                  </text>
                </box>
                <ChartCanvas cells={chartCells} />
              </box>
              <text wrapMode="none">
                <span style={{ fg: T.dim }}>rain </span>
                <For
                  each={sparkline(
                    next24().map((h) => h.precipitationProbability ?? 0),
                    0,
                    100,
                  )}
                >
                  {(ch, i) => (
                    <span
                      style={{
                        fg: hexOf(precipScale(next24()[i()]?.precipitationProbability ?? 0)),
                      }}
                    >
                      {ch.repeat(Math.max(1, Math.floor((dims().width - 12) / 24)))}
                    </span>
                  )}
                </For>
              </text>
              <text fg={T.dim}>
                {"     "}
                {next24()
                  .filter((_, i) => i % 3 === 0)
                  .map((h) =>
                    fmtTime(h.time, tz(), false)
                      .replace(" ", "")
                      .toLowerCase()
                      .padEnd(Math.max(1, Math.floor((dims().width - 12) / 24)) * 3),
                  )
                  .join("")}
              </text>
            </box>
          </box>
        );
      }}
    </Show>
  );
}

// ─── Hourly view ───────────────────────────────────────────────────────────

function HourlyView(props: { state: AppState; report: Report }) {
  const hours = createMemo(() => {
    const f = props.report.forecast;
    if (!f) return [];
    const now = Date.now();
    const i = Math.max(0, f.hourly.findIndex((h) => new Date(h.time).getTime() > now) - 1);
    return f.hourly.slice(i, i + 48);
  });
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={T.border}
      title=" next 48 hours "
      paddingLeft={1}
    >
      <text fg={T.dim}>
        {"time      sky  temp  feels  rain   precip    wind           humidity"}
      </text>
      <scrollbox flexGrow={1}>
        <For each={hours()}>
          {(h) => {
            const pp = h.precipitationProbability ?? 0;
            const day = new Date(h.time).toLocaleDateString("en-US", {
              weekday: "short",
              timeZone: tz(),
            });
            return (
              <text wrapMode="none">
                <span style={{ fg: T.dim }}>
                  {`${day} ${fmtTime(h.time, tz(), false)}`.padEnd(10)}
                </span>
                <span style={{ fg: T.accent }}>
                  {`${conditionGlyph(h.condition, h.isDay)}`.padEnd(4)}{" "}
                </span>
                <span style={{ fg: tcolor(h.temperature) }}>
                  {temp(h.temperature, u()).padStart(5)}{" "}
                </span>
                <span style={{ fg: tcolor(h.feelsLike ?? h.temperature) }}>
                  {temp(h.feelsLike ?? h.temperature, u()).padStart(6)}{" "}
                </span>
                <span style={{ fg: hexOf(precipScale(pp)) }}>
                  {`${Math.round(pp)}%`.padStart(5)} {"█".repeat(Math.round(pp / 20)).padEnd(5)}
                </span>
                <span style={{ fg: T.dim }}>{precip(h.precipitation, u()).padStart(8)} </span>
                <span style={{ fg: T.text }}>
                  {`${windArrow(h.windDirection)} ${speed(h.windSpeed, u())}`.padEnd(14)}
                </span>
                <span style={{ fg: T.dim }}>{`${h.humidity ?? "--"}%`.padStart(4)}</span>
              </text>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}

// ─── Daily view ────────────────────────────────────────────────────────────

function DailyView(props: { state: AppState; report: Report }) {
  const days = () => props.report.forecast?.daily ?? [];
  const lo = () => Math.min(...days().map((d) => d.tempMin));
  const hi = () => Math.max(...days().map((d) => d.tempMax));
  const u = () => props.state.units;
  const BAR = 32;
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={T.border}
      title=" 10-day outlook "
      paddingLeft={1}
      paddingTop={1}
    >
      <For each={days()}>
        {(d) => {
          const a = Math.round(((d.tempMin - lo()) / (hi() - lo() || 1)) * BAR);
          const b = Math.max(a + 1, Math.round(((d.tempMax - lo()) / (hi() - lo() || 1)) * BAR));
          const pp = d.precipitationProbability ?? 0;
          const name = new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          });
          return (
            <box flexDirection="column" height={2}>
              <text wrapMode="none">
                <span style={{ fg: T.text }}>{name.padEnd(12)}</span>
                <span style={{ fg: T.accent }}>{conditionGlyph(d.condition).padEnd(3)}</span>
                <span style={{ fg: T.dim }}>{CONDITION_LABEL[d.condition].padEnd(24)}</span>
                <span style={{ fg: tcolor(d.tempMin) }}>
                  {temp(d.tempMin, u(), false).padStart(5)}{" "}
                </span>
                <For each={Array.from({ length: BAR }, (_, i) => i)}>
                  {(i) => {
                    if (i < a || i >= b) return <span style={{ fg: T.faint }}>─</span>;
                    const t = d.tempMin + ((i - a) / Math.max(1, b - a)) * (d.tempMax - d.tempMin);
                    return <span style={{ fg: tcolor(t) }}>━</span>;
                  }}
                </For>
                <span style={{ fg: tcolor(d.tempMax) }}>
                  {" "}
                  {temp(d.tempMax, u(), false).padEnd(5)}
                </span>
                <span style={{ fg: hexOf(precipScale(pp)) }}>
                  {`☂ ${Math.round(pp)}%`.padStart(7)}
                </span>
                <span style={{ fg: T.dim }}> {precip(d.precipitationSum, u()).padStart(8)}</span>
                <span style={{ fg: T.dim }}> {`${speed(d.windGustMax, u())} gusts`}</span>
              </text>
              <text> </text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

// ─── Alerts view ───────────────────────────────────────────────────────────

function AlertsView(props: { state: AppState; report: Report }) {
  const alerts = () => props.report.alerts;
  const selected = (): Alert | undefined => alerts()[props.state.alertIndex];
  const tz = () => props.state.location.timezone;
  return (
    <Show
      when={alerts().length}
      fallback={
        <box
          flexGrow={1}
          border
          borderStyle="rounded"
          borderColor={T.border}
          justifyContent="center"
          alignItems="center"
        >
          <text fg={T.ok}>✓ No active alerts for {props.state.location.name}</text>
        </box>
      }
    >
      <box flexDirection="row" flexGrow={1} gap={1}>
        <box
          width={40}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={T.border}
          title=" active "
        >
          <For each={alerts()}>
            {(a, i) => (
              <text bg={i() === props.state.alertIndex ? T.border : T.bg}>
                <span style={{ fg: hexOf(SEVERITY_COLOR[a.severity]) }}> ▲ </span>
                <span style={{ fg: T.text }}>{a.event.slice(0, 34)}</span>
              </text>
            )}
          </For>
        </box>
        <Show when={selected()}>
          {(a: () => Alert) => (
            <scrollbox
              flexGrow={1}
              border
              borderStyle="rounded"
              borderColor={hexOf(SEVERITY_COLOR[a().severity])}
              title={` ${a().event} `}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={hexOf(SEVERITY_COLOR[a().severity])}>
                {a().severity.toUpperCase()} · until {fmtTime(a().expires, tz())}
              </text>
              <text fg={T.dim}>{a().areas ?? ""}</text>
              <text> </text>
              <text fg={T.text}>{a().headline ?? ""}</text>
              <text> </text>
              <text fg={T.text}>{a().description ?? ""}</text>
              <Show when={a().instruction}>
                <text> </text>
                <text fg={T.warn}>{a().instruction}</text>
              </Show>
            </scrollbox>
          )}
        </Show>
      </box>
    </Show>
  );
}

// ─── Help overlay ──────────────────────────────────────────────────────────

const HELP: Array<[string, string]> = [
  ["1-7 / tab", "switch view"],
  ["space , .", "radar play/pause, step frames"],
  ["i", "radar: real image ↔ text cells"],
  ["u", "toggle °C / °F"],
  ["r", "refresh now"],
  ["m", "toggle animations"],
  ["←↑↓→ / hjkl", "pan map"],
  ["+ / -", "zoom map"],
  ["c", "center map on location"],
  ["S F H Q A", "map layers: storms fires hotspots quakes alerts"],
  ["?", "toggle help"],
  ["q / ctrl+c", "quit"],
];

function Help() {
  return (
    <box
      position="absolute"
      top={3}
      left={4}
      width={44}
      border
      borderStyle="double"
      borderColor={T.accent}
      backgroundColor={T.panel}
      title=" keys "
      flexDirection="column"
      paddingLeft={1}
      zIndex={10}
    >
      <For each={HELP}>
        {([k, d]) => (
          <text wrapMode="none">
            <span style={{ fg: T.accent }}>{k.padEnd(14)}</span>
            <span style={{ fg: T.text }}>{d}</span>
          </text>
        )}
      </For>
    </box>
  );
}

// ─── App ───────────────────────────────────────────────────────────────────

export function App(props: Props): JSX.Element {
  const renderer = useRenderer();
  const { state, setState } = props;

  let radar: RadarControls | undefined;

  useKeyboard((key) => {
    const n = key.name;
    if (n === "q" || (key.ctrl && n === "c")) return props.quit();
    if (n === "?") return setState("showHelp", (v) => !v);
    if (n === "escape") return setState("showHelp", false);
    if (/^[1-7]$/.test(n)) return setState("view", VIEWS[Number(n) - 1] ?? "now");
    if (n === "tab") {
      const i = VIEWS.indexOf(state.view);
      return setState(
        "view",
        VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length] ?? "now",
      );
    }
    if (n === "u") return setState("units", (u) => (u === "metric" ? "imperial" : "metric"));
    if (n === "r") return props.refresh();
    if (n === "m") return setState("motion", (m) => !m);
    if (state.view === "radar") {
      if (n === "space") return radar?.toggle();
      if (n === "i") return setState("radarMode", (m) => (m === "auto" ? "cells" : "auto"));
      if (n === "," || n === "<") return radar?.step(-1);
      if (n === "." || n === ">") return radar?.step(1);
      if (n === "+" || n === "=") return setState("radarZoom", (z) => Math.min(60, z * 1.5));
      if (n === "-" || n === "_") return setState("radarZoom", (z) => Math.max(6, z / 1.5));
    }
    if (state.view === "map" && key.shift) {
      const toggle = { s: "storms", f: "fires", h: "hotspots", q: "quakes", a: "alerts" } as const;
      const layer = toggle[n as keyof typeof toggle];
      if (layer) return setState("layers", layer, (v) => !v);
    }
    if (state.view === "map") {
      const step = 30 / state.camera.zoom;
      if (n === "left" || n === "h")
        setState("camera", "lon", (l) => ((l - step + 540) % 360) - 180);
      if (n === "right" || n === "l")
        setState("camera", "lon", (l) => ((l + step + 540) % 360) - 180);
      if (n === "up" || n === "k") setState("camera", "lat", (l) => Math.min(80, l + step / 2));
      if (n === "down" || n === "j") setState("camera", "lat", (l) => Math.max(-80, l - step / 2));
      if (n === "+" || n === "=") setState("camera", "zoom", (z) => Math.min(64, z * 2));
      if (n === "-" || n === "_") setState("camera", "zoom", (z) => Math.max(1, z / 2));
      if (n === "0") setState("camera", { lon: state.location.lon, lat: 0, zoom: 1 });
      if (n === "c")
        setState("camera", {
          lon: state.location.lon,
          lat: state.location.lat,
          zoom: Math.max(4, state.camera.zoom),
        });
    }
    if (state.view === "alerts") {
      const len = state.report?.alerts.length ?? 0;
      if (n === "down" || n === "j") setState("alertIndex", (i) => Math.min(len - 1, i + 1));
      if (n === "up" || n === "k") setState("alertIndex", (i) => Math.max(0, i - 1));
    }
  });

  // Auto refresh every 10 minutes.
  onMount(() => {
    const id = setInterval(() => props.refresh(), 10 * 60_000);
    onCleanup(() => clearInterval(id));
  });
  void renderer;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={T.bg}>
      <Header state={state} />
      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Show
          when={state.report}
          fallback={
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <text fg={state.error ? T.danger : T.accent}>
                {state.error ?? "◌ fetching the sky…"}
              </text>
            </box>
          }
        >
          {(report: () => Report) => (
            <Switch>
              <Match when={state.view === "now"}>
                <NowView state={state} report={report()} />
              </Match>
              <Match when={state.view === "hourly"}>
                <HourlyView state={state} report={report()} />
              </Match>
              <Match when={state.view === "daily"}>
                <DailyView state={state} report={report()} />
              </Match>
              <Match when={state.view === "radar"}>
                <RadarView state={state} http={props.http} controls={(c) => (radar = c)} />
              </Match>
              <Match when={state.view === "map"}>
                <MapView state={state} />
              </Match>
              <Match when={state.view === "hazards"}>
                <HazardsView state={state} />
              </Match>
              <Match when={state.view === "alerts"}>
                <AlertsView state={state} report={report()} />
              </Match>
            </Switch>
          )}
        </Show>
      </box>
      <Footer state={state} />
      <Show when={state.showHelp}>
        <Help />
      </Show>
    </box>
  );
}
