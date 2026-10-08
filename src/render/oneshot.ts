import type { Capabilities } from "../capabilities.ts";
import { moonGlyph } from "../domain/astronomy.ts";
import { CONDITION_LABEL, conditionGlyph } from "../domain/conditions.ts";
import type { Report, Severity } from "../domain/types.ts";
import { cellsToAnsi, padEnd, paint } from "./ansi.ts";
import { conditionArt } from "./art.ts";
import { lineChart, sparkline } from "./charts.ts";
import { aqiScale, hex, type RGB, scale, temperatureScale } from "./color.ts";
import { compass, distance, precip, pressure, speed, temp, windArrow } from "./units.ts";

const DIM = hex("#7a8794");
const TEXT = hex("#e6edf3");
const ACCENT = hex("#7dd3fc");
const SEVERITY_COLOR: Record<Severity, RGB> = {
  extreme: hex("#ff1744"),
  severe: hex("#ff6d00"),
  moderate: hex("#ffd600"),
  minor: hex("#64b5f6"),
  unknown: hex("#b0bec5"),
};
const precipScale = scale([
  [0, "#37474f"],
  [20, "#4f7cac"],
  [60, "#29b6f6"],
  [100, "#00e5ff"],
]);
const uvScale = scale([
  [0, "#4caf50"],
  [3, "#ffeb3b"],
  [6, "#ff9800"],
  [8, "#f44336"],
  [11, "#9c27b0"],
]);

function fmtTime(iso: string | undefined, tz?: string): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

function fmtHour(iso: string, tz?: string): string {
  return new Date(iso)
    .toLocaleTimeString("en-US", { hour: "numeric", timeZone: tz })
    .replace(" ", "")
    .toLowerCase();
}

function fmtDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/** Render a report as a pretty, static terminal summary. */
export function renderOneShot(report: Report, caps: Capabilities): string {
  const lvl = caps.color;
  const p = (s: string, c?: RGB, bg?: RGB) => paint(s, c, lvl, bg);
  const tc = (c: number) => temperatureScale(c);
  const { forecast: fc, location: loc, units } = report;
  const tz = loc.timezone;
  const width = Math.min(Math.max(caps.columns, 60), 110);
  const out: string[] = [];

  const place = [loc.name, loc.region, loc.countryCode].filter(Boolean).join(", ");
  out.push("");
  out.push(
    ` ${p("◆", ACCENT)} ${p(place, TEXT)}  ${p(`${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`, DIM)}`,
  );

  if (!fc) {
    out.push(p("  Forecast unavailable.", SEVERITY_COLOR.severe));
  } else {
    const c = fc.current;
    const art = conditionArt(c.condition, c.isDay).map((runs) =>
      runs.map(([t, col]) => p(t, col)).join(""),
    );
    const today = fc.daily[0];
    const info = [
      `${p(temp(c.temperature, units), tc(c.temperature))}  ${p(CONDITION_LABEL[c.condition], TEXT)}`,
      `${p("feels", DIM)} ${p(temp(c.feelsLike ?? c.temperature, units), tc(c.feelsLike ?? c.temperature))}   ${
        today
          ? `${p("↑", DIM)}${p(temp(today.tempMax, units), tc(today.tempMax))} ${p("↓", DIM)}${p(temp(today.tempMin, units), tc(today.tempMin))}`
          : ""
      }`,
      `${p(windArrow(c.windDirection), ACCENT)} ${p(speed(c.windSpeed, units), TEXT)} ${p(compass(c.windDirection), DIM)}${
        c.windGust ? p(`  gusts ${speed(c.windGust, units)}`, DIM) : ""
      }`,
      `${p("humidity", DIM)} ${p(`${c.humidity ?? "--"}%`, TEXT)}  ${p("pressure", DIM)} ${p(pressure(c.pressure, units), TEXT)}`,
      `${p("visibility", DIM)} ${p(distance(c.visibility, units), TEXT)}  ${p("UV", DIM)} ${p(
        String(Math.round(c.uvIndex ?? 0)),
        uvScale(c.uvIndex ?? 0),
      )}`,
    ];
    out.push("");
    for (let i = 0; i < Math.max(art.length, info.length); i++) {
      out.push(`  ${padEnd(art[i] ?? "", 15)} ${info[i] ?? ""}`);
    }

    // Next 24 hours: braille temperature curve + precip probability sparkline.
    const nowMs = Date.now();
    const start = Math.max(0, fc.hourly.findIndex((h) => new Date(h.time).getTime() > nowMs) - 1);
    const next = fc.hourly.slice(start, start + 24);
    if (next.length > 2) {
      const chartCols = Math.min(width - 10, 72);
      const temps = next.map((h) => h.temperature);
      const lo = Math.min(...temps);
      const hi = Math.max(...temps);
      out.push("");
      out.push(`  ${p("Next 24 hours", ACCENT)}`);
      const chart = cellsToAnsi(lineChart(temps, chartCols, 4, tc), lvl);
      chart.forEach((line, i) => {
        const label =
          i === 0 ? temp(hi, units, false) : i === chart.length - 1 ? temp(lo, units, false) : "";
        out.push(`  ${p(label.padStart(4), DIM)} ${line}`);
      });
      const probs = next.map((h) => h.precipitationProbability ?? 0);
      const spark = sparkline(probs, 0, 100);
      const stretched = Array.from({ length: chartCols }, (_, i) => {
        const k = Math.floor((i / chartCols) * next.length);
        return p(spark[k] ?? " ", precipScale(probs[k] ?? 0));
      }).join("");
      out.push(`  ${p("rain", DIM)} ${stretched}`);
      const axis = Array.from({ length: chartCols }, () => " ");
      for (let k = 0; k < next.length; k += 6) {
        const label = fmtHour(next[k]?.time ?? "", tz);
        const col = Math.floor((k / next.length) * chartCols);
        [...label].forEach((ch, j) => {
          if (col + j < chartCols) axis[col + j] = ch;
        });
      }
      out.push(`       ${p(axis.join(""), DIM)}`);
    }

    // Daily outlook with a temperature range bar scaled across the whole period.
    const days = fc.daily.slice(0, 10);
    if (days.length) {
      const lo = Math.min(...days.map((d) => d.tempMin));
      const hi = Math.max(...days.map((d) => d.tempMax));
      const barW = Math.max(10, Math.min(30, width - 60));
      out.push("");
      out.push(`  ${p(`${days.length}-day outlook`, ACCENT)}`);
      for (const d of days) {
        const a = Math.round(((d.tempMin - lo) / (hi - lo || 1)) * barW);
        const b = Math.max(a + 1, Math.round(((d.tempMax - lo) / (hi - lo || 1)) * barW));
        const bar = Array.from({ length: barW }, (_, i) => {
          if (i < a || i >= b) return p("─", hex("#2b3640"));
          const t = d.tempMin + ((i - a) / Math.max(1, b - a)) * (d.tempMax - d.tempMin);
          return p("━", tc(t));
        }).join("");
        const pp = d.precipitationProbability ?? 0;
        out.push(
          `  ${p(fmtDay(d.date).padEnd(4), TEXT)}${p(conditionGlyph(d.condition), ACCENT)}  ${p(
            temp(d.tempMin, units, false).padStart(4),
            tc(d.tempMin),
          )} ${bar} ${p(temp(d.tempMax, units, false).padEnd(4), tc(d.tempMax))} ${p(
            `${String(Math.round(pp)).padStart(3)}%`,
            precipScale(pp),
          )} ${p(precip(d.precipitationSum, units), DIM)}`,
        );
      }
    }
  }

  // Sun, moon, air.
  const astro = report.astronomy;
  const aq = report.airQuality;
  const extras: string[] = [];
  if (astro) {
    extras.push(
      `${p("☀", hex("#ffd54f"))} ${p(fmtTime(astro.sunrise, tz), TEXT)} ${p("→", DIM)} ${p(fmtTime(astro.sunset, tz), TEXT)}`,
    );
    extras.push(
      `${p(moonGlyph(astro.moonPhase), hex("#e0e6f0"))} ${p(astro.moonPhaseName, TEXT)} ${p(
        `${Math.round(astro.moonIllumination * 100)}%`,
        DIM,
      )}`,
    );
  }
  if (aq?.usAqi !== undefined) {
    extras.push(`${p("AQI", DIM)} ${p(String(Math.round(aq.usAqi)), aqiScale(aq.usAqi))}`);
  }
  if (extras.length) {
    out.push("");
    out.push(`  ${extras.join(p("  │  ", hex("#2b3640")))}`);
  }

  if (report.alerts.length) {
    out.push("");
    for (const a of report.alerts.slice(0, 5)) {
      const col = SEVERITY_COLOR[a.severity];
      const until = a.expires ? p(` until ${fmtTime(a.expires, tz)}`, DIM) : "";
      out.push(`  ${p("▲", col)} ${p(a.event.toUpperCase(), col)}${until}`);
    }
    if (report.alerts.length > 5) out.push(p(`    +${report.alerts.length - 5} more`, DIM));
  }

  for (const e of report.errors) {
    out.push(p(`  ! ${e.provider}: ${e.message}`, DIM));
  }
  out.push("");
  return out.join("\n");
}
