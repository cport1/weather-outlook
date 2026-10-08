import { createMemo, For, Show } from "solid-js";
import type { Report } from "../../domain/types.ts";
import { blockBar } from "../../render/charts-multi.ts";
import { anomalyScale, isWet, nextTwoHours, nowcastScale } from "../../render/details.ts";
import type { Units } from "../../render/units.ts";
import { tempDelta } from "../../render/units-more.ts";
import { hexOf } from "../format.ts";
import { T } from "../theme.ts";

/**
 * Small pieces of the detail data that live inside existing views:
 * the nowcast headline on Now and the anomaly column on 10-Day.
 */

/** "☂ Light rain starting in ~30 min" plus a 2-hour precipitation bar underneath. */
export function NowcastLine(props: { report: Report; width?: number }) {
  const n = () => props.report.nowcast;
  const pts = createMemo(() => {
    const nc = n();
    if (!nc) return [];
    const all = nextTwoHours(nc);
    // Downsample 1–5 minute nowcasts so the bar fits the panel.
    const max = Math.max(4, (props.width ?? 40) - 6);
    const step = Math.max(1, Math.ceil(all.length / max));
    return all.filter((_, i) => i % step === 0);
  });
  const bars = () =>
    blockBar(
      pts().map((q) => q.rate),
      Math.max(2, ...pts().map((q) => q.rate)),
    );
  const headline = () => (n()?.headline ?? "").replace("No precipitation expected", "Dry");
  return (
    <Show when={n()} fallback={<text> </text>}>
      <text wrapMode="none">
        <span style={{ fg: isWet(n()) ? T.accent : T.dim }}>{isWet(n()) ? "☂ " : "· "}</span>
        <span style={{ fg: isWet(n()) ? T.text : T.dim }}>{headline()}</span>
      </text>
      <Show when={isWet(n())}>
        <text wrapMode="none">
          <span style={{ fg: T.dim }}>{"  "}</span>
          <For each={bars()}>
            {(ch, i) => (
              <span style={{ fg: hexOf(nowcastScale(pts()[i()]?.rate ?? 0)) }}>{ch}</span>
            )}
          </For>
          <span style={{ fg: T.dim }}> 2h</span>
        </text>
      </Show>
    </Show>
  );
}

/** Forecast-high anomaly vs the 30-year normal for a date, e.g. " +5°". */
export function AnomalyCell(props: {
  report: Report;
  date: string;
  units: Units;
  /** Row background (e.g. a selected-row highlight). */
  bg?: string;
}) {
  const day = () => props.report.climate?.days.find((d) => d.date === props.date);
  return (
    <Show when={day()?.highAnomaly !== undefined}>
      <span style={{ fg: hexOf(anomalyScale(day()?.highAnomaly ?? 0)), bg: props.bg }}>
        {` ${tempDelta(day()?.highAnomaly, props.units).padStart(4)} vs avg`}
      </span>
    </Show>
  );
}
