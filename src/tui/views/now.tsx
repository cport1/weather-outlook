import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { moonGlyph, moonPosition, sunPosition } from "../../domain/astronomy.ts";
import { CONDITION_LABEL } from "../../domain/conditions.ts";
import type { Astronomy, Condition, DailyPoint, Forecast, Report } from "../../domain/types.ts";
import { lineChart, sparkline } from "../../render/charts.ts";
import { aqiScale, hex, lerp, type RGB, temperatureScale } from "../../render/color.ts";
import { mulberry32, WeatherFx } from "../../render/fx.ts";
import { dewComfort, pressureTrend, uvScale } from "../../render/gauges.ts";
import { horizonGlow, moonDisk, skyColors, skyPoint } from "../../render/sky.ts";
import { compass, distance, pressure, speed, temp, windArrow } from "../../render/units.ts";
import type { DrawApi } from "../cell-canvas.ts";
import {
  currentHourIndex,
  fmtTime,
  hexOf,
  precipScale,
  SIMULATE,
  sceneKind,
  shortHour,
  tcolor,
} from "../format.ts";
import type { AppState } from "../store.ts";
import { T } from "../theme.ts";
import { GAUGES_HEIGHT, Gauges } from "../widgets/gauges.tsx";
import { AnimatedIcon } from "../widgets/icon.tsx";
import { fitFont } from "../widgets/splash.tsx";
import { NowcastLine } from "./details-bits.tsx";
import { RiskBadges } from "./risk-badge.tsx";

// ─── Sky scene ─────────────────────────────────────────────────────────────

const SUN_CORE = hex("#fff3b0");
const SUN_LOW = hex("#ffab40");
const GLOW = hex("#ff9e5e");
const MOON_LIT = hex("#eef0dc");
const STORMY = new Set<Condition>(["thunderstorm", "hail", "heavy-rain"]);

interface CloudPuff {
  x: number;
  y: number;
  w: number;
  h: number;
  speed: number;
}

function Scene(props: {
  condition: Condition;
  isDay: boolean;
  precipRate: number;
  windKmh: number;
  cloudCover: number;
  lat: number;
  lon: number;
  motion: boolean;
  active: boolean;
}) {
  const fx = new WeatherFx(40, 12, sceneKind(props.condition, props.isDay));
  const rand = mulberry32(7);
  const puffs: CloudPuff[] = Array.from({ length: 6 }, () => ({
    x: rand(),
    y: rand(),
    w: 9 + Math.floor(rand() * 8),
    h: 2 + Math.floor(rand() * 2),
    speed: 0.6 + rand() * 0.8,
  }));
  let clock = 0;
  let astroAt = -1;
  let sun = sunPosition(props.lat, props.lon);
  let moon = moonPosition(props.lat, props.lon);

  const cloudCount = () => {
    const cover = STORMY.has(props.condition) ? 100 : props.cloudCover;
    return Math.min(puffs.length, Math.round(cover / 18));
  };

  const draw = (api: DrawApi, w: number, h: number, dt: number) => {
    fx.kind = sceneKind(props.condition, props.isDay);
    fx.intensity = Math.min(1, props.precipRate / 6 + 0.3);
    fx.wind = Math.max(-12, Math.min(12, props.windKmh / 4));
    fx.resize(w, h);
    if (props.motion) {
      fx.step(dt);
      clock += dt;
    }
    // Real sun/moon positions, refreshed every few seconds.
    if (astroAt < 0 || Date.now() - astroAt > 5_000) {
      astroAt = Date.now();
      sun = sunPosition(props.lat, props.lon);
      moon = moonPosition(props.lat, props.lon);
    }
    const south = props.lat < 0;
    const stormy = STORMY.has(props.condition);
    const { top, horizon } = skyColors(sun.altitude, props.cloudCover, stormy);
    const glow = horizonGlow(sun.altitude) * (1 - props.cloudCover / 160);
    const sunAt = skyPoint(sun.azimuth, sun.altitude, w, h, south);
    const glowX = sunAt?.x ?? skyPoint(sun.azimuth, 0, w, h, south)?.x ?? w / 2;
    const flash = fx.flashLevel;
    const sunHalo = lerp(SUN_LOW, SUN_CORE, Math.min(1, Math.max(0, sun.altitude / 25)));
    // The sun scales with the sky panel and fades behind cloud.
    const sunR = Math.max(1.5, Math.min(w / 2, h) * 0.09);
    const sunVisible = Math.max(0, 1 - props.cloudCover / 90);

    // Gradient, with a warm glow pooled around the sun near the horizon.
    for (let y = 0; y < h; y++) {
      const t = y / Math.max(1, h - 1);
      const row = lerp(top, horizon, t ** 1.4);
      for (let x = 0; x < w; x++) {
        let c: RGB = row;
        if (glow > 0) {
          const dx = (x - glowX) / Math.max(8, w * 0.45);
          const k = glow * Math.max(0, 1 - dx * dx) * t ** 2;
          if (k > 0) c = lerp(c, GLOW, k * 0.8);
        }
        if (sunAt && !stormy) {
          // Wide soft glow sized to the sky; cells are ~2:1 tall, so x spans twice y.
          const k = 1 - Math.hypot((x - sunAt.x) / (sunR * 6), (y - sunAt.y) / (sunR * 3));
          if (k > 0) c = lerp(c, sunHalo, k * k * 0.55 * sunVisible);
        }
        if (flash > 0) c = c.map((v) => Math.min(255, v + flash * 90)) as unknown as RGB;
        api.cell(x, y, " ", undefined, c);
      }
    }

    // Stars come out once the sky is dark enough, if it's clear.
    if (sun.altitude < -6 && props.cloudCover < 70 && fx.kind !== "clear-night") {
      const r = mulberry32(11);
      const n = Math.floor((w * h) / 45);
      for (let i = 0; i < n; i++) {
        const sx = Math.floor(r() * w);
        const sy = Math.floor(r() * h * 0.7);
        const tw = props.motion ? (Math.sin(clock / 700 + i) + 1) / 2 : 0.5;
        api.blend(sx, sy, tw > 0.9 ? "✦" : "·", lerp(hex("#3a4a5a"), hex("#fffde7"), tw));
      }
    }

    // Moon with its real phase, then the sun with a soft halo.
    const moonAt = skyPoint(moon.azimuth, moon.altitude, w, h, south);
    if (moonAt && (sun.altitude < 4 || moon.altitude > 10)) {
      const disk = moonDisk(moon.phase, 3, 2, MOON_LIT, south);
      api.grid(disk, Math.max(0, moonAt.x - 1), Math.max(0, moonAt.y - 1));
    }
    if (sunAt && !stormy && sunVisible > 0) {
      // Faint rays that slowly turn, then a solid disk with a hot center.
      const turn = props.motion ? clock / 9000 : 0;
      for (let i = 0; i < 12; i++) {
        const a = turn + (i / 12) * Math.PI * 2;
        for (let r = sunR * 1.5; r < sunR * 2.6; r += 0.5) {
          const rx = Math.round(sunAt.x + Math.cos(a) * r * 2);
          const ry = Math.round(sunAt.y + Math.sin(a) * r);
          const fade = 1 - (r - sunR * 1.5) / (sunR * 1.1);
          api.blend(
            rx,
            ry,
            i % 2 ? "·" : "•",
            lerp(sunHalo, SUN_CORE, 0.4),
            fade * 0.8 * sunVisible,
          );
        }
      }
      for (let dy = -Math.ceil(sunR); dy <= Math.ceil(sunR); dy++) {
        for (let dx = -Math.ceil(sunR * 2); dx <= Math.ceil(sunR * 2); dx++) {
          const d = Math.hypot(dx / 2, dy) / sunR;
          if (d > 1) continue;
          const core = lerp(SUN_CORE, hex("#ffffff"), (1 - d) * 0.7);
          api.cell(
            Math.round(sunAt.x + dx),
            Math.round(sunAt.y + dy),
            " ",
            undefined,
            lerp(sunHalo, core, 0.6 + 0.4 * sunVisible),
          );
        }
      }
    }

    // Drifting cloud banks.
    const nClouds = cloudCount();
    const cloudColor = lerp(
      stormy ? hex("#3b4250") : hex("#9aa7b5"),
      hex("#dfe6ee"),
      Math.max(0, Math.min(1, (sun.altitude + 6) / 30)) * (stormy ? 0.3 : 1),
    );
    for (let i = 0; i < nClouds; i++) {
      const p = puffs[i];
      if (!p) continue;
      const span = w + p.w;
      const cx =
        ((((p.x * span + (clock / 1000) * p.speed * (1 + Math.abs(fx.wind) / 4)) % span) + span) %
          span) -
        p.w / 2;
      const cy = Math.floor(p.y * Math.max(1, h * 0.45));
      for (let yy = 0; yy < p.h; yy++) {
        for (let xx = 0; xx < p.w; xx++) {
          const nx = (xx - p.w / 2 + 0.5) / (p.w / 2);
          const ny = (yy - p.h / 2 + 0.5) / (p.h / 2);
          const d = nx * nx + ny * ny;
          if (d > 1) continue;
          const ch = d < 0.3 ? "▓" : d < 0.65 ? "▒" : "░";
          api.blend(Math.floor(cx + xx), cy + yy, ch, cloudColor);
        }
      }
    }

    for (const c of fx.cells()) api.blend(c.x, c.y, c.ch, c.fg);
  };

  const live = () =>
    props.motion &&
    props.active &&
    (sceneKind(props.condition, props.isDay) !== "clear-day" || cloudCount() > 0);
  return <cell_canvas live={live()} flexGrow={1} height="100%" draw={draw} />;
}

// ─── Count-up temperature ──────────────────────────────────────────────────

/** Animates toward `target` (°C) whenever it or `key` changes; instant without motion. */
function useCountUp(target: () => number, key: () => unknown, motion: () => boolean) {
  const [shown, setShown] = createSignal(target());
  let timer: ReturnType<typeof setInterval> | undefined;
  let first = true;
  createEffect(
    on([target, key], () => {
      const to = target();
      if (timer) clearInterval(timer);
      if (!motion() || !Number.isFinite(to)) {
        setShown(to);
        first = false;
        return;
      }
      const prev = shown();
      let from = first ? to - 15 : prev;
      if (Math.abs(from - to) < 1) from = to - 5;
      first = false;
      const t0 = Date.now();
      const dur = 900;
      setShown(from);
      timer = setInterval(() => {
        const k = Math.min(1, (Date.now() - t0) / dur);
        const e = 1 - (1 - k) ** 3;
        setShown(from + (to - from) * e);
        if (k >= 1 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      }, 33);
    }),
  );
  onCleanup(() => timer && clearInterval(timer));
  return shown;
}

/** Largest font where the final value fits beside the icon (fixed so count-up doesn't jump). */
const bigFont = (text: string) => fitFont(text, 27, ["block", "slick", "tiny"]) ?? "tiny";

// ─── Now view ──────────────────────────────────────────────────────────────

function Metric(props: { label: string; value: string; color?: string; extra?: string }) {
  return (
    <text wrapMode="none">
      <span style={{ fg: T.dim }}>{props.label.padEnd(12)}</span>
      <span style={{ fg: props.color ?? T.text }}>{props.value}</span>
      <span style={{ fg: T.dim }}>{props.extra ?? ""}</span>
    </text>
  );
}

function ChartCanvas(props: { cells: () => ReturnType<typeof lineChart> }) {
  return <cell_canvas flexGrow={1} height="100%" draw={(api) => api.grid(props.cells())} />;
}

export function NowView(props: { state: AppState; report: Report }) {
  const fc = () => props.report.forecast;
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  const dims = useTerminalDimensions();
  const cond = (): Condition => {
    const s = props.state.simulate;
    return (s && SIMULATE[s]) || fc()?.current.condition || "unknown";
  };
  const next24 = createMemo(() => {
    const f = fc();
    if (!f) return [];
    const i = currentHourIndex(f.hourly);
    return f.hourly.slice(i, i + 24);
  });
  // Responsive layout: drop the sky panel when narrow, the chart and gauges when short.
  const showSky = () => dims().width >= 96;
  const showChart = () => dims().height >= 30;
  const showGauges = () => dims().height - 2 - (showChart() ? 9 : 0) - 2 >= 24;
  const chartWidth = () => Math.max(20, dims().width - 12);
  const chartCells = createMemo(() =>
    lineChart(
      next24().map((h) => h.temperature),
      chartWidth(),
      5,
      temperatureScale,
    ),
  );
  const shownTemp = useCountUp(
    () => fc()?.current.temperature ?? Number.NaN,
    () => props.report.generatedAt,
    () => props.state.motion,
  );
  const trend = createMemo(() => {
    const f = fc();
    return f ? pressureTrend(f.hourly, f.current.pressure) : undefined;
  });
  const simulatedCloud = () => {
    const s = props.state.simulate;
    if (!s) return undefined;
    return s === "clear" ? 0 : s === "cloudy" ? 100 : s === "partly" ? 45 : 85;
  };
  return (
    <Show when={fc()} fallback={<text fg={T.dim}>No forecast data.</text>}>
      {(f: () => Forecast) => {
        const c = () => f().current;
        const today = () => f().daily[0];
        return (
          <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" flexGrow={1} gap={1}>
              <Show when={showSky()}>
                <box flexGrow={1} border borderStyle="rounded" borderColor={T.border} title=" sky ">
                  <Scene
                    condition={cond()}
                    isDay={c().isDay}
                    precipRate={c().precipitation ?? 0}
                    windKmh={
                      (c().windSpeed ?? 0) *
                      (Math.sin(((c().windDirection ?? 270) * Math.PI) / 180) > 0 ? -1 : 1)
                    }
                    cloudCover={simulatedCloud() ?? c().cloudCover ?? 0}
                    lat={props.state.location.lat}
                    lon={props.state.location.lon}
                    motion={props.state.motion}
                    active={props.state.focused}
                  />
                </box>
              </Show>
              <box
                width={showSky() ? 44 : undefined}
                flexGrow={showSky() ? 0 : 1}
                flexDirection="column"
                border
                borderStyle="rounded"
                borderColor={T.border}
                paddingLeft={1}
                title=" now "
              >
                <box flexDirection="row" height={6} gap={1}>
                  <box flexDirection="column" width={27} justifyContent="center">
                    <ascii_font
                      text={temp(shownTemp(), u())}
                      font={bigFont(temp(c().temperature, u()))}
                      color={tcolor(shownTemp())}
                    />
                  </box>
                  <AnimatedIcon
                    condition={cond()}
                    isDay={c().isDay}
                    motion={props.state.motion && props.state.focused}
                  />
                </box>
                <text fg={T.text} wrapMode="none">
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
                <NowcastLine report={props.report} />
                <Metric
                  label="wind"
                  value={`${windArrow(c().windDirection)} ${speed(c().windSpeed, u())} ${compass(c().windDirection)}`}
                  color={T.accent}
                  extra={c().windGust !== undefined ? ` gusts ${speed(c().windGust, u())}` : ""}
                />
                <Metric label="humidity" value={`${c().humidity ?? "--"}%`} />
                <Metric
                  label="dew point"
                  value={c().dewPoint !== undefined ? temp(c().dewPoint as number, u()) : "--"}
                  extra={
                    c().dewPoint !== undefined ? ` · ${dewComfort(c().dewPoint as number)}` : ""
                  }
                />
                <Metric
                  label="pressure"
                  value={pressure(c().pressure, u())}
                  extra={trend() ? ` ${trend()?.arrow} ${trend()?.label}` : ""}
                />
                <Metric label="visibility" value={distance(c().visibility, u())} />
                <Metric label="cloud cover" value={`${c().cloudCover ?? "--"}%`} />
                <RiskBadges risks={props.report.risks} />
                <Show when={!showGauges()}>
                  <Metric
                    label="UV index"
                    value={String(Math.round(c().uvIndex ?? 0))}
                    color={hexOf(uvScale(c().uvIndex ?? 0))}
                  />
                  <Show when={props.report.airQuality?.usAqi !== undefined}>
                    <Metric
                      label="air (AQI)"
                      value={String(Math.round(props.report.airQuality?.usAqi ?? 0))}
                      color={hexOf(aqiScale(props.report.airQuality?.usAqi ?? 0))}
                    />
                  </Show>
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
                <Show when={showGauges()}>
                  <box flexGrow={1} />
                  <box height={GAUGES_HEIGHT} flexShrink={0}>
                    <Gauges
                      windDirection={c().windDirection}
                      windSpeed={c().windSpeed}
                      windGust={c().windGust}
                      uv={c().uvIndex}
                      aqi={props.report.airQuality?.usAqi}
                      motion={props.state.motion && props.state.focused}
                    />
                  </box>
                </Show>
              </box>
            </box>
            <Show when={showChart() && next24().length > 0}>
              <box
                height={9}
                flexShrink={0}
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
                        {ch.repeat(Math.max(1, Math.floor(chartWidth() / 24)))}
                      </span>
                    )}
                  </For>
                </text>
                <text fg={T.dim} wrapMode="none">
                  {"     "}
                  {next24()
                    .filter((_, i) => i % 3 === 0)
                    .map((h) =>
                      shortHour(h.time, tz()).padEnd(
                        Math.max(1, Math.floor(chartWidth() / 24)) * 3,
                      ),
                    )
                    .join("")}
                </text>
              </box>
            </Show>
          </box>
        );
      }}
    </Show>
  );
}
