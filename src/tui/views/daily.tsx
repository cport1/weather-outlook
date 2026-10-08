import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { CONDITION_LABEL, conditionGlyph } from "../../domain/conditions.ts";
import type { DailyPoint, Report } from "../../domain/types.ts";
import { uvScale } from "../../render/gauges.ts";
import { precip, speed, temp } from "../../render/units.ts";
import { fmtTime, hexOf, precipScale, tcolor } from "../format.ts";
import type { AppState } from "../store.ts";
import { T } from "../theme.ts";
import { AnimatedIcon } from "../widgets/icon.tsx";
import { AnomalyCell } from "./details-bits.tsx";

const dayName = (d: DailyPoint, long = false) =>
  new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: long ? "long" : "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

function DayDetail(props: { day: DailyPoint; state: AppState }) {
  const u = () => props.state.units;
  const tz = () => props.state.location.timezone;
  const d = () => props.day;
  return (
    <box flexDirection="column">
      <text fg={T.text} wrapMode="none">
        {dayName(d(), true)}
      </text>
      <box height={1} />
      <box flexDirection="row" height={5}>
        <AnimatedIcon
          condition={d().condition}
          isDay
          motion={props.state.motion && props.state.focused}
        />
      </box>
      <text fg={T.accent} wrapMode="none">
        {CONDITION_LABEL[d().condition]}
      </text>
      <text wrapMode="none">
        <span style={{ fg: tcolor(d().tempMax) }}>{temp(d().tempMax, u())}</span>
        <span style={{ fg: T.dim }}> / </span>
        <span style={{ fg: tcolor(d().tempMin) }}>{temp(d().tempMin, u())}</span>
      </text>
      <text wrapMode="none">
        <span style={{ fg: T.dim }}>rain </span>
        <span style={{ fg: hexOf(precipScale(d().precipitationProbability ?? 0)) }}>
          {`${Math.round(d().precipitationProbability ?? 0)}% `}
        </span>
        <span style={{ fg: T.dim }}>{precip(d().precipitationSum, u())}</span>
      </text>
      <text wrapMode="none">
        <span style={{ fg: T.dim }}>wind </span>
        <span style={{ fg: T.text }}>{speed(d().windSpeedMax, u())}</span>
        <span style={{ fg: T.dim }}> gusts {speed(d().windGustMax, u())}</span>
      </text>
      <text wrapMode="none">
        <span style={{ fg: T.dim }}>UV </span>
        <span style={{ fg: hexOf(uvScale(d().uvIndexMax ?? 0)) }}>
          {String(Math.round(d().uvIndexMax ?? 0))}
        </span>
      </text>
      <text wrapMode="none">
        <span style={{ fg: T.dim }}>sun </span>
        <span style={{ fg: T.warn }}>
          {fmtTime(d().sunrise, tz())} → {fmtTime(d().sunset, tz())}
        </span>
      </text>
    </box>
  );
}

export function DailyView(props: {
  state: AppState;
  setState: SetStoreFunction<AppState>;
  report: Report;
}) {
  const dims = useTerminalDimensions();
  const days = () => props.report.forecast?.daily ?? [];
  const lo = () => Math.min(...days().map((d) => d.tempMin));
  const hi = () => Math.max(...days().map((d) => d.tempMax));
  const u = () => props.state.units;
  const side = () => dims().width >= 120;
  const mainWidth = () => dims().width - 2 - 3 - (side() ? 33 : 0);
  const showLabel = () => mainWidth() >= 100;
  const bar = () => Math.max(8, Math.min(32, mainWidth() - (showLabel() ? 85 : 61)));
  const rowHeight = () => (dims().height - 2 - 3 >= days().length * 2 ? 2 : 1);
  const selected = () => days()[Math.min(props.state.dayIndex, days().length - 1)];
  return (
    <box flexDirection="row" flexGrow={1} gap={1}>
      <box
        flexDirection="column"
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={T.border}
        title=" 10-day outlook "
        paddingLeft={1}
        paddingTop={rowHeight() === 2 ? 1 : 0}
      >
        <For each={days()}>
          {(d, idx) => {
            const isSel = () => idx() === props.state.dayIndex;
            const bg = () => (isSel() ? T.border : T.bg);
            const select = () => props.setState("dayIndex", idx());
            return (
              <box
                flexDirection="column"
                height={rowHeight()}
                onMouseOver={select}
                onMouseDown={select}
              >
                <text wrapMode="none" bg={bg()}>
                  <span style={{ fg: isSel() ? T.accent : T.text, bg: bg() }}>
                    {`${isSel() ? "▸" : " "}${dayName(d)}`.padEnd(13)}
                  </span>
                  <span style={{ fg: T.accent, bg: bg() }}>
                    {conditionGlyph(d.condition).padEnd(3)}
                  </span>
                  <Show when={showLabel()}>
                    <span style={{ fg: T.dim, bg: bg() }}>
                      {CONDITION_LABEL[d.condition].padEnd(24)}
                    </span>
                  </Show>
                  <span style={{ fg: tcolor(d.tempMin), bg: bg() }}>
                    {temp(d.tempMin, u(), false).padStart(5)}{" "}
                  </span>
                  <For each={Array.from({ length: bar() }, (_, i) => i)}>
                    {(i) => {
                      const span = () => hi() - lo() || 1;
                      const a = () => Math.round(((d.tempMin - lo()) / span()) * bar());
                      const b = () =>
                        Math.max(a() + 1, Math.round(((d.tempMax - lo()) / span()) * bar()));
                      return (
                        <Show
                          when={i >= a() && i < b()}
                          fallback={<span style={{ fg: T.faint, bg: bg() }}>─</span>}
                        >
                          <span
                            style={{
                              fg: tcolor(
                                d.tempMin +
                                  ((i - a()) / Math.max(1, b() - a())) * (d.tempMax - d.tempMin),
                              ),
                              bg: bg(),
                            }}
                          >
                            ━
                          </span>
                        </Show>
                      );
                    }}
                  </For>
                  <span style={{ fg: tcolor(d.tempMax), bg: bg() }}>
                    {" "}
                    {temp(d.tempMax, u(), false).padEnd(5)}
                  </span>
                  <span
                    style={{ fg: hexOf(precipScale(d.precipitationProbability ?? 0)), bg: bg() }}
                  >
                    {`☂ ${Math.round(d.precipitationProbability ?? 0)}%`.padStart(7)}
                  </span>
                  <span style={{ fg: T.dim, bg: bg() }}>
                    {" "}
                    {precip(d.precipitationSum, u()).padStart(8)}
                  </span>
                  <span style={{ fg: T.dim, bg: bg() }}>
                    {" "}
                    {`${speed(d.windGustMax, u())} gusts`}
                  </span>
                  <AnomalyCell report={props.report} date={d.date} units={u()} bg={bg()} />
                </text>
                <Show when={rowHeight() === 2}>
                  <text> </text>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
      <Show when={side() && selected()}>
        {(day: () => DailyPoint) => (
          <box
            width={32}
            border
            borderStyle="rounded"
            borderColor={T.border}
            title=" day "
            paddingLeft={1}
            paddingTop={1}
          >
            <DayDetail day={day()} state={props.state} />
          </box>
        )}
      </Show>
    </box>
  );
}
