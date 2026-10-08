import type { Capabilities } from "../capabilities.ts";
import type { Nowcast, TideEvent } from "../domain/details.ts";
import type { Report } from "../domain/types.ts";
import { paint } from "./ansi.ts";
import { blockBar } from "./charts-multi.ts";
import { aqiScale, hex, type RGB, scale } from "./color.ts";
import { compass, temp } from "./units.ts";
import { height, ordinal, tempDelta } from "./units-more.ts";

/** Shared colors/formatting for the detail sections (one-shot and dashboard). */

/** Temperature anomaly (°C vs normal) → diverging blue/grey/red. */
export const anomalyScale = scale([
  [-8, "#4f8dff"],
  [-3, "#7fb2ff"],
  [0, "#9aa5b1"],
  [3, "#ffb36b"],
  [8, "#ff5a4f"],
]);

export const nowcastScale = scale([
  [0, "#2b3640"],
  [0.1, "#4f7cac"],
  [2.5, "#29b6f6"],
  [7.6, "#00e5ff"],
  [20, "#e040fb"],
]);

export const MODEL_COLORS: Record<string, RGB> = {
  best_match: hex("#e6edf3"),
  gfs_seamless: hex("#ff8a65"),
  ecmwf_ifs025: hex("#4dd0e1"),
  icon_seamless: hex("#aed581"),
  met_norway: hex("#ce93d8"),
};
export const modelColor = (id: string): RGB => MODEL_COLORS[id] ?? hex("#b0bec5");

export const CONFIDENCE_COLOR = {
  high: hex("#69f0ae"),
  moderate: hex("#ffd54f"),
  low: hex("#ff7043"),
} as const;

export const HEAT_RISK = ["None", "Minor", "Moderate", "Major", "Extreme"] as const;

export function isWet(n: Nowcast | undefined): boolean {
  return Boolean(n?.points.some((p) => p.rate >= 0.1));
}

/** Points covering the next two hours. */
export function nextTwoHours(n: Nowcast, now = Date.now()) {
  return n.points.filter((p) => {
    const t = Date.parse(p.time);
    return t >= now - n.interval * 60_000 && t <= now + 120 * 60_000;
  });
}

export function nextTides(events: TideEvent[], now = Date.now(), count = 2): TideEvent[] {
  return events.filter((e) => Date.parse(e.time) >= now).slice(0, count);
}

function fmtTime(iso: string, tz?: string): string {
  return new Date(iso)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })
    .replace(" ", "")
    .toLowerCase();
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Concise extra lines for the one-shot summary. */
export function renderDetailsOneShot(report: Report, caps: Capabilities): string[] {
  const lvl = caps.color;
  const p = (s: string, c?: RGB) => paint(s, c, lvl);
  const DIM = hex("#7a8794");
  const TEXT = hex("#e6edf3");
  const ACCENT = hex("#7dd3fc");
  const { units } = report;
  const tz = report.location.timezone;
  const width = Math.min(Math.max(caps.columns, 60), 110);
  const out: string[] = [];

  const n = report.nowcast;
  if (n && isWet(n)) {
    const pts = nextTwoHours(n);
    const step = Math.max(1, Math.ceil(pts.length / 24));
    const sampled = pts.filter((_, i) => i % step === 0);
    const bar = blockBar(
      sampled.map((q) => q.rate),
      Math.max(2, ...sampled.map((q) => q.rate)),
    )
      .map((ch, i) => p(ch, nowcastScale(sampled[i]?.rate ?? 0)))
      .join("");
    out.push(`${p("☂", ACCENT)} ${p(n.headline, TEXT)}  ${bar} ${p("2h", DIM)}`);
  }

  const cl = report.climate;
  const d0 = cl?.days[0];
  if (cl && d0) {
    const parts = [
      `${p("normal", DIM)} ${p(temp(d0.normalHigh, units, false), TEXT)}${p("/", DIM)}${p(temp(d0.normalLow, units, false), TEXT)}`,
    ];
    if (d0.highAnomaly !== undefined) {
      parts.push(
        `${p("today", DIM)} ${p(tempDelta(d0.highAnomaly, units), anomalyScale(d0.highAnomaly))}${
          d0.highPercentile !== undefined ? p(` (${ordinal(d0.highPercentile)} pct)`, DIM) : ""
        }`,
      );
    }
    if (cl.fact) parts.push(p(cl.fact, hex("#ffd54f")));
    out.push(`${p("◷", ACCENT)} ${parts.join(p(" · ", DIM))}`);
  }

  const conf = report.models?.confidence;
  if (conf) {
    out.push(
      `${p("≋", ACCENT)} ${p("forecast confidence", DIM)} ${p(`${conf.score}% ${conf.label}`, CONFIDENCE_COLOR[conf.label])}${
        conf.modelSpread !== undefined
          ? p(
              ` · ${report.models?.models.length ?? 0} models within ${tempDelta(conf.modelSpread, units).replace(/^[+±]/, "")}`,
              DIM,
            )
          : ""
      }`,
    );
  }

  const m = report.marine;
  if (m) {
    const bits: string[] = [];
    const w = m.waves?.current;
    if (w?.height !== undefined) {
      bits.push(
        `${p("waves", DIM)} ${p(height(w.height, units), TEXT)}${w.period ? p(` ${Math.round(w.period)}s`, DIM) : ""}${
          w.direction !== undefined ? p(` from ${compass(w.direction)}`, DIM) : ""
        }`,
      );
    }
    if (w?.seaSurfaceTemperature !== undefined) {
      bits.push(`${p("sea", DIM)} ${p(temp(w.seaSurfaceTemperature, units), TEXT)}`);
    }
    const tides = m.tides ? nextTides(m.tides.events) : [];
    if (tides.length) {
      bits.push(
        tides
          .map(
            (t) =>
              `${p(t.type, DIM)} ${p(fmtTime(t.time, tz), TEXT)} ${p(height(t.height, units), DIM)}`,
          )
          .join(" "),
      );
    }
    if (bits.length) out.push(`${p("〜", ACCENT)} ${bits.join(p(" · ", DIM))}`);
  }

  const hourly = report.airQuality?.hourly;
  if (hourly?.length) {
    const now = Date.now();
    const next = hourly.filter((h) => {
      const t = Date.parse(h.time);
      return t >= now && t < now + 24 * 3_600_000 && h.usAqi !== undefined;
    });
    const peak = next.reduce<(typeof next)[number] | undefined>(
      (a, h) => (!a || (h.usAqi ?? 0) > (a.usAqi ?? 0) ? h : a),
      undefined,
    );
    if (peak?.usAqi !== undefined) {
      out.push(
        `${p("◌", ACCENT)} ${p("AQI peak next 24h", DIM)} ${p(String(Math.round(peak.usAqi)), aqiScale(peak.usAqi))} ${p(`at ${fmtTime(peak.time, tz)}`, DIM)}`,
      );
    }
  }

  const period = report.nws?.periods[0];
  if (period) {
    const label = `NWS ${period.name}: `;
    out.push(
      `${p(label, ACCENT)}${p(truncate(period.detailedForecast, width - label.length - 4), TEXT)}`,
    );
  }

  return out.map((l) => `  ${l}`);
}
