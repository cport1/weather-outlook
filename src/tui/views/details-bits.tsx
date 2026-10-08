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

/** "☂ Light rain starting in ~30 min ▁▃▆▃▁" on one line (it replaces a spacer row). */
export function NowcastLine(props: { report: Report }) {
  const n = () => props.report.nowcast;
  const pts = createMemo(() => {
    const nc = n();
    if (!nc) return [];
    const all = nextTwoHours(nc);
    // At most 8 cells, so 1–5 minute nowcasts fit next to the headline.
    const step = Math.max(1, Math.ceil(all.length / 8));
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
        <Show when={isWet(n())}>
          <span> </span>
          <For each={bars()}>
            {(ch, i) => (
              <span style={{ fg: hexOf(nowcastScale(pts()[i()]?.rate ?? 0)) }}>{ch}</span>
            )}
          </For>
        </Show>
      </text>
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
  /** Just the delta, without "vs avg". */
  compact?: boolean;
}) {
  const day = () => props.report.climate?.days.find((d) => d.date === props.date);
  return (
    <Show when={day()?.highAnomaly !== undefined}>
      <span style={{ fg: hexOf(anomalyScale(day()?.highAnomaly ?? 0)), bg: props.bg }}>
        {` ${tempDelta(day()?.highAnomaly, props.units).padStart(4)}${props.compact ? "" : " vs avg"}`}
      </span>
    </Show>
  );
}
