import { For, Show } from "solid-js";
import type { Fire, Hazards, Quake, SpaceWeather, Storm } from "../../domain/types.ts";
import { auroraLatitude } from "../../providers/swpc.ts";
import { hex, type RGB, scale, stormCategoryColor, toHex } from "../../render/color.ts";
import { quakeColor } from "../../render/hazard-layers.ts";
import { speed } from "../../render/units.ts";
import type { AppState } from "../store.ts";
import { T } from "../theme.ts";

const kpScale = scale([
  [0, "#69f0ae"],
  [4, "#ffee58"],
  [5, "#ffa726"],
  [7, "#ef5350"],
  [9, "#ab47bc"],
]);
const c = (rgb: RGB) => toHex(rgb);

function ago(iso: string | undefined): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\d+\s+/, "")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(bLat - aLat) / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function catLabel(s: Storm): string {
  if (s.category >= 1) return `Category ${s.category}`;
  return s.category === 0 ? "Tropical Storm" : "Depression";
}

function StormCard(props: { s: Storm; state: AppState }) {
  const col = () => c(stormCategoryColor(props.s.category));
  const intensity = () =>
    props.s.track.filter((p) => p.windKt !== undefined).map((p) => p.windKt as number);
  const peak = () => Math.max(...intensity(), 1);
  const SPARK = "▁▂▃▄▅▆▇█";
  const bars = () => {
    const pts = props.s.track.filter((p) => p.windKt !== undefined);
    // Downsample long tracks so the sparkline fits the card.
    const step = Math.max(1, Math.ceil(pts.length / 26));
    return pts
      .filter((_, i) => i % step === 0)
      .map((p) => ({
        ch: SPARK[Math.min(7, Math.round(((p.windKt as number) / peak()) * 7))] ?? "▁",
        fg: c(stormCategoryColor(p.category ?? -1)),
        fc: p.forecast,
      }));
  };
  return (
    <box flexDirection="column" paddingBottom={1}>
      <text wrapMode="none">
        <span style={{ fg: col() }}>{props.s.category >= 1 ? "◉ " : "@ "}</span>
        <span style={{ fg: T.text }}>{props.s.name}</span>
        <span style={{ fg: col() }}> {catLabel(props.s)}</span>
        <span style={{ fg: T.dim }}> · {props.s.basin ?? props.s.provider.toUpperCase()}</span>
      </text>
      <text wrapMode="none" fg={T.dim}>
        {"  "}
        {props.s.windKt !== undefined ? speed(props.s.windKt * 1.852, props.state.units) : "--"}
        {props.s.pressureMb ? ` · ${props.s.pressureMb} mb` : ""}
        {props.s.movement ? ` · moving ${props.s.movement}` : ""}
      </text>
      <Show when={bars().length > 1}>
        <text wrapMode="none">
          <span style={{ fg: T.dim }}>{"  wind "}</span>
          <For each={bars()}>{(b) => <span style={{ fg: b.fc ? T.dim : b.fg }}>{b.ch}</span>}</For>
          <span style={{ fg: T.faint }}> → fcst</span>
        </text>
      </Show>
    </box>
  );
}

export function HazardsView(props: { state: AppState }) {
  const hz = (): Hazards | undefined => props.state.hazards;
  const loc = () => props.state.location;
  const nearbyQuakes = (): Array<Quake & { km: number }> =>
    (hz()?.quakes ?? [])
      .map((q) => ({ ...q, km: distanceKm(loc().lat, loc().lon, q.lat, q.lon) }))
      .sort((a, b) => b.magnitude - a.magnitude)
      .slice(0, 12);
  const bigFires = (): Fire[] =>
    (hz()?.fires ?? []).filter((f) => (f.containment ?? 0) < 100).slice(0, 12);
  return (
    <Show
      when={hz()}
      fallback={
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text wrapMode="none" fg={T.accent}>
            ◌ scanning the planet for trouble…
          </text>
        </box>
      }
    >
      {(h: () => Hazards) => (
        <box flexDirection="row" flexGrow={1} gap={1}>
          <box flexDirection="column" width="34%" gap={0}>
            <box
              flexGrow={1}
              flexDirection="column"
              border
              borderStyle="rounded"
              borderColor={T.border}
              title={` tropics (${h().storms.length}) `}
              paddingLeft={1}
            >
              <Show
                when={h().storms.length}
                fallback={
                  <text wrapMode="none" fg={T.ok}>
                    ✓ No active tropical cyclones
                  </text>
                }
              >
                <For each={h().storms}>{(s) => <StormCard s={s} state={props.state} />}</For>
              </Show>
            </box>
            <Show when={h().space}>
              {(sp: () => SpaceWeather) => {
                const kp = () => sp().kp ?? 0;
                const edge = () => auroraLatitude(kp());
                const visible = () => Math.abs(loc().lat) >= edge() - 5;
                return (
                  <box
                    height={7}
                    flexDirection="column"
                    border
                    borderStyle="rounded"
                    borderColor={T.border}
                    title=" space weather "
                    paddingLeft={1}
                  >
                    <text wrapMode="none">
                      <span style={{ fg: T.dim }}>Kp </span>
                      <span style={{ fg: c(kpScale(kp())) }}>
                        {"█".repeat(Math.max(1, Math.round(kp() * 2)))}
                      </span>
                      <span style={{ fg: c(kpScale(kp())) }}> {kp().toFixed(1)}</span>
                      <span style={{ fg: T.dim }}>
                        {"  "}G{sp().scales?.G ?? 0} S{sp().scales?.S ?? 0} R{sp().scales?.R ?? 0}
                      </span>
                    </text>
                    <text wrapMode="none" fg={T.dim}>
                      solar wind {sp().solarWindSpeed ?? "--"} km/s · Bz {sp().bz ?? "--"} nT
                    </text>
                    <text wrapMode="none" fg={visible() ? T.ok : T.dim}>
                      {visible()
                        ? `✦ aurora possible near ${Math.round(edge())}° lat — look north tonight`
                        : `aurora oval near ${Math.round(edge())}° lat (you're at ${Math.round(Math.abs(loc().lat))}°)`}
                    </text>
                  </box>
                );
              }}
            </Show>
          </box>
          <box
            flexGrow={1}
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={T.border}
            title={` wildfires · ${h().fires.length} US · ${h().hotspots.length.toLocaleString()} hotspots `}
            paddingLeft={1}
          >
            <text wrapMode="none" fg={T.dim}>
              {"name                   acres     contained"}
            </text>
            <For each={bigFires()}>
              {(f) => {
                const pct = f.containment ?? 0;
                return (
                  <text wrapMode="none">
                    <span style={{ fg: c(hex("#ff7043")) }}>▲ </span>
                    <span style={{ fg: T.text }}>
                      {titleCase(f.name ?? "Unnamed")
                        .slice(0, 22)
                        .padEnd(23)}
                    </span>
                    <span style={{ fg: T.warn }}>
                      {Math.round(f.acres ?? 0)
                        .toLocaleString()
                        .padStart(9)}
                    </span>
                    <span style={{ fg: T.dim }}> </span>
                    <span style={{ fg: T.ok }}>{"█".repeat(Math.round(pct / 12.5))}</span>
                    <span style={{ fg: T.faint }}>{"░".repeat(8 - Math.round(pct / 12.5))}</span>
                    <span style={{ fg: T.dim }}> {Math.round(pct)}%</span>
                  </text>
                );
              }}
            </For>
          </box>
          <box
            width="32%"
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={T.border}
            title={` earthquakes 24h (${h().quakes.length}) `}
            paddingLeft={1}
          >
            <For each={nearbyQuakes()}>
              {(q) => (
                <box flexDirection="column">
                  <text wrapMode="none">
                    <span style={{ fg: c(quakeColor(q)) }}>M{q.magnitude.toFixed(1)} </span>
                    <span style={{ fg: T.text }}>{q.place.slice(0, 34)}</span>
                    <Show when={q.tsunami}>
                      <span style={{ fg: T.danger }}> ≋ tsunami</span>
                    </Show>
                  </text>
                  <text wrapMode="none" fg={T.dim}>
                    {"     "}
                    {Math.round(q.depthKm)} km deep · {ago(q.time)} ·{" "}
                    {Math.round(q.km).toLocaleString()} km away
                  </text>
                </box>
              )}
            </For>
          </box>
        </box>
      )}
    </Show>
  );
}
