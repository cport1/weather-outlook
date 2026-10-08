import { For, Show } from "solid-js";
import type { RiskSummary } from "../../domain/types.ts";
import { toHex } from "../../render/color.ts";
import { riskColor } from "../../render/hazard-layers.ts";
import { T } from "../theme.ts";

const LABEL: Partial<Record<RiskSummary["product"], string>> = {
  categorical: "severe",
  rainfall: "flood risk",
  fire: "fire wx",
};

/** Today's notable SPC/WPC risks at the location ("Severe risk today" badge for the Now view). */
export function riskBadges(risks: RiskSummary[] | undefined): RiskSummary[] {
  return (risks ?? []).filter(
    (r) =>
      r.day === 1 &&
      LABEL[r.product] !== undefined &&
      (r.product !== "categorical" || r.level >= 2),
  );
}

export function RiskBadges(props: { risks: RiskSummary[] | undefined }) {
  return (
    <Show when={riskBadges(props.risks).length}>
      <For each={riskBadges(props.risks)}>
        {(r) => (
          <text wrapMode="none">
            <span style={{ fg: T.dim }}>{(LABEL[r.product] ?? r.product).padEnd(12)}</span>
            <span style={{ fg: T.bg, bg: toHex(riskColor(r)) }}> {r.label} </span>
            <span style={{ fg: toHex(riskColor(r)) }}> {r.name}</span>
          </text>
        )}
      </For>
    </Show>
  );
}
