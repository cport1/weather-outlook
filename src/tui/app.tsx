import type { KeyEvent, OptimizedBuffer } from "@opentui/core";
import { onBlur, onFocus, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { Alert, Location, Report } from "../domain/types.ts";
import { clockTime } from "../render/units.ts";
import type { HttpClient } from "../util/http.ts";
import { setAnimationsPaused } from "./cell-canvas.ts";
import { fmtTime, hexOf, SEVERITY_COLOR } from "./format.ts";
import { scrollbarGutter } from "./scroll.ts";
import { type AppState, VIEW_LABEL, VIEWS, type View } from "./store.ts";
import { cycleTheme, isMono, T } from "./theme.ts";
import { Credits, closeCredits, toggleCredits } from "./views/credits.tsx";
import { DailyView } from "./views/daily.tsx";
import { DetailsView } from "./views/details.tsx";
import { HazardsView } from "./views/hazards.tsx";
import { HOURS, HourlyView, SERIES_KEYS } from "./views/hourly.tsx";
import { type MapControls, MapView } from "./views/map.tsx";
import { NowView } from "./views/now.tsx";
import { type RadarControls, RadarView, toggleSatellite } from "./views/radar.tsx";
import { currentSuggestions, placeLabel, SearchOverlay } from "./widgets/search.tsx";
import { Splash } from "./widgets/splash.tsx";

interface Props {
  http: HttpClient;
  state: AppState;
  setState: SetStoreFunction<AppState>;
  refresh: () => void;
  quit: () => void;
  /** Switch the dashboard to another place (defaults to updating state + refresh). */
  switchLocation?: (loc: Location) => void;
}

const SHORT_LABEL: Partial<Record<View, string>> = {
  now: "Now",
  hourly: "Hrs",
  daily: "10d",
  radar: "Radar",
  map: "Map",
  hazards: "Haz",
  alerts: "Alrt",
  details: "More",
};

const samePlaceAs = (a: Location, b: Location) =>
  Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

// ─── Header / footer ───────────────────────────────────────────────────────

function Header(props: { state: AppState; select: (v: View) => void }) {
  const dims = useTerminalDimensions();
  const loc = () => props.state.location;
  // Narrow terminals keep just the place name so the clock and tabs still fit.
  const place = () =>
    dims().width < 110
      ? loc().name
      : [loc().name, loc().region, loc().countryCode].filter(Boolean).join(", ");
  const clock = () => clockTime(new Date(), loc().timezone);
  // 0 = full labels, 1 = short labels, 2 = numbers (active tab keeps its label).
  const labelAt = (v: View, i: number, density: 0 | 1 | 2) => {
    const n =
      props.state.view === v || density === 0
        ? VIEW_LABEL[v]
        : density === 1
          ? (SHORT_LABEL[v] ?? VIEW_LABEL[v].slice(0, 4))
          : "";
    const count =
      v === "alerts" && props.state.report?.alerts.length
        ? ` (${props.state.report.alerts.length})`
        : "";
    return n ? ` ${i + 1} ${n}${count} ` : ` ${i + 1}${count ? "!" : ""} `;
  };
  // The richest header that fits: full labels, then short labels, then short labels
  // without the clock, then bare numbers.
  const layout = createMemo(() => {
    const width = dims().width - 2;
    const tabs = (d: 0 | 1 | 2) => VIEWS.reduce((n, v, i) => n + labelAt(v, i, d).length, 0);
    const lead = (d: 0 | 1 | 2, withClock: boolean) =>
      (d === 0 ? 18 : 2) + place().length + (withClock ? 3 + clock().length : 0);
    const options: Array<[0 | 1 | 2, boolean]> = [
      [0, true],
      [1, true],
      [1, false],
      [2, true],
      [2, false],
    ];
    const min = dims().width >= 130 ? 0 : dims().width >= 80 ? 1 : 2;
    const fit = options.find(([d, c]) => d >= min && lead(d, c) + tabs(d) <= width);
    return fit ?? ([2, false] as const);
  });
  const density = () => layout()[0];
  const label = (v: View, i: number) => labelAt(v, i, density());
  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1} backgroundColor={T.panel}>
      <text wrapMode="none" flexShrink={1}>
        <span style={{ fg: T.accent, bg: T.panel }}>
          {density() === 0 ? "◆ weather-outlook " : "◆ "}
        </span>
        <span style={{ fg: T.text, bg: T.panel }}>{place()}</span>
        <Show when={layout()[1]}>
          <span style={{ fg: T.dim, bg: T.panel }}> · {clock()}</span>
        </Show>
      </text>
      <box flexGrow={1} />
      <box flexDirection="row" flexShrink={0}>
        <For each={[...VIEWS]}>
          {(v, i) => (
            <text
              wrapMode="none"
              fg={props.state.view === v ? T.bg : T.dim}
              bg={props.state.view === v ? T.accent : T.panel}
              onMouseDown={() => props.select(v)}
            >
              {label(v, i())}
            </text>
          )}
        </For>
      </box>
    </box>
  );
}

function Footer(props: { state: AppState }) {
  const dims = useTerminalDimensions();
  const status = () => {
    if (props.state.loading) return "refreshing…";
    if (props.state.error) return `error: ${props.state.error}`;
    if (!props.state.lastUpdated) return "";
    const mins = Math.round((Date.now() - props.state.lastUpdated) / 60_000);
    return mins < 1 ? "updated just now" : `updated ${mins}m ago`;
  };
  const hints = () => {
    switch (props.state.view) {
      case "map":
        return "drag/←↑↓→ pan  wheel/+- zoom  g goto  i inspect  c center  ? layers";
      case "radar":
        return "space play/pause  ,/. step  +/- zoom  v satellite";
      case "alerts":
        return "↑↓ select alert";
      case "hourly":
        return "←→ cursor  t/p/w/h/v series";
      case "daily":
        return "↑↓ select day";
      case "details":
        return "←→ panel  ↑↓ scroll discussion";
      default:
        return `tab/1-${VIEWS.length} views`;
    }
  };
  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1} backgroundColor={T.panel}>
      <text wrapMode="none" flexShrink={1}>
        <span style={{ fg: T.dim, bg: T.panel }}>{hints()}</span>
        <span style={{ fg: T.faint, bg: T.panel }}> │ </span>
        <span style={{ fg: T.dim, bg: T.panel }}>
          {dims().width >= 110
            ? "/ search s next place u units r refresh ? help q quit"
            : "/ search ? help q quit"}
        </span>
      </text>
      <box flexGrow={1} />
      <text wrapMode="none" fg={props.state.error ? T.danger : T.dim} flexShrink={0}>
        {status()}
      </text>
    </box>
  );
}

// ─── Alerts view ───────────────────────────────────────────────────────────

function AlertsView(props: { state: AppState; report: Report }) {
  const dims = useTerminalDimensions();
  const alerts = () => props.report.alerts;
  const selected = (): Alert | undefined => alerts()[props.state.alertIndex];
  const tz = () => props.state.location.timezone;
  const listWidth = () => Math.max(24, Math.min(40, Math.floor(dims().width * 0.35)));
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
          width={listWidth()}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={T.border}
          title=" active "
        >
          <For each={alerts()}>
            {(a, i) => {
              const bg = () => (i() === props.state.alertIndex ? T.border : T.bg);
              return (
                <text wrapMode="none" bg={bg()}>
                  <span style={{ fg: hexOf(SEVERITY_COLOR[a.severity]), bg: bg() }}> ▲ </span>
                  <span style={{ fg: T.text, bg: bg() }}>{a.event.slice(0, listWidth() - 6)}</span>
                </text>
              );
            }}
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
              scrollX={false}
              contentOptions={scrollbarGutter()}
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
  [`1-${VIEWS.length} / tab`, "switch view (or click a tab)"],
  ["← → [ ]", "details: switch panel (↑↓ scroll discussion)"],
  ["/", "search for a location"],
  ["s", "cycle saved & recent locations"],
  ["← →", "hourly: move chart cursor"],
  ["t p w h v", "hourly: toggle temp/precip/wind/humidity/UV"],
  ["↑ ↓", "10-day: select day · alerts: select"],
  ["space , .", "radar play/pause, step frames"],
  ["i", "radar: real image ↔ text cells"],
  ["v", "radar: satellite base layer"],
  ["u", "toggle °C / °F"],
  ["T", "cycle theme"],
  ["r", "refresh now"],
  ["m", "toggle animations"],
  ["←↑↓→ / hjkl", "pan map"],
  ["+ / -", "zoom map"],
  ["c", "center map on location"],
  ["S F H Q A E R", "map hazard layers"],
  ["T W P C", "map temp/wind/rain/cloud (T elsewhere: theme)"],
  ["N O L", "night · aurora · cities"],
  ["g", "map: fly to a place"],
  ["i / click", "inspect hazards (tab ⏎)"],
  ["drag / wheel", "pan / zoom at pointer"],
  ["?", "toggle help"],
  ["!", "data credits"],
  ["q / ctrl+c", "quit"],
];

function Help() {
  const dims = useTerminalDimensions();
  return (
    <box
      position="absolute"
      top={2}
      left={Math.max(0, Math.min(4, dims().width - 62))}
      width={Math.min(62, dims().width)}
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
            <span style={{ fg: T.accent, bg: T.panel }}>{k.padEnd(14)}</span>
            <span style={{ fg: T.text, bg: T.panel }}>{d}</span>
          </text>
        )}
      </For>
    </box>
  );
}

// ─── App ───────────────────────────────────────────────────────────────────

/** Drain hue from every cell after rendering when the mono theme is active (NO_COLOR). */
export function monoFilter(buffer: OptimizedBuffer): void {
  if (!isMono()) return;
  const { fg, bg } = buffer.buffers;
  for (const arr of [fg, bg]) {
    for (let i = 0; i + 3 < arr.length; i += 4) {
      const l = Math.round(
        0.299 * (arr[i] ?? 0) + 0.587 * (arr[i + 1] ?? 0) + 0.114 * (arr[i + 2] ?? 0),
      );
      arr[i] = l;
      arr[i + 1] = l;
      arr[i + 2] = l;
    }
  }
}

export function App(props: Props): JSX.Element {
  const renderer = useRenderer();
  const { state, setState } = props;

  let radar: RadarControls | undefined;
  let map: MapControls | undefined;

  const remember = (loc: Location) => {
    if (!state.recent.some((r) => samePlaceAs(r, loc)))
      setState("recent", (r) => [...r, loc].slice(-12));
  };
  remember(state.location);

  const switchTo = (loc: Location) => {
    setState("search", { open: false, query: "", results: [], index: 0, busy: false });
    if (samePlaceAs(loc, state.location)) return;
    remember(loc);
    if (props.switchLocation) return props.switchLocation(loc);
    setState({
      location: loc,
      report: undefined,
      camera: { lon: loc.lon, lat: 0, zoom: 1 },
      hourCursor: 0,
      dayIndex: 0,
      alertIndex: 0,
    });
    props.refresh();
  };

  /** `s`: step through saved then recent places in a stable order. */
  const cyclePlace = () => {
    const all: Location[] = [];
    for (const l of [...state.saved, ...state.recent])
      if (!all.some((a) => samePlaceAs(a, l))) all.push(l);
    if (all.length < 2) return;
    const i = all.findIndex((l) => samePlaceAs(l, state.location));
    const next = all[(i + 1) % all.length];
    if (next) switchTo(next);
  };

  const searchKeys = (key: KeyEvent) => {
    const n = key.name;
    const list = currentSuggestions(state);
    if (n === "escape") return setState("search", "open", false);
    if (n === "down" || (key.ctrl && n === "n"))
      return setState("search", "index", (i) => Math.min(Math.max(0, list.length - 1), i + 1));
    if (n === "up" || (key.ctrl && n === "p"))
      return setState("search", "index", (i) => Math.max(0, i - 1));
    if (n === "return" || n === "enter") {
      const pick = list[state.search.index];
      if (pick) switchTo(pick);
    }
  };

  useKeyboard((key) => {
    const n = key.name;
    if (key.ctrl && n === "c") return props.quit();
    if (state.search.open) return searchKeys(key);
    // The map gets first look so its prompt/inspect modes (incl. Tab) and shift-letter layers win.
    if (state.view === "map" && !state.showHelp && map?.key(key)) return;
    if (n === "q" && !key.shift) return props.quit();
    if (n === "?" || key.sequence === "?") return setState("showHelp", (v) => !v);
    if (n === "!" || key.sequence === "!") return toggleCredits();
    if (n === "escape") {
      closeCredits();
      return setState("showHelp", false);
    }
    if (n === "/" || n === "slash" || key.sequence === "/") {
      // Don't let the keystroke that opens the box land in its input.
      key.preventDefault();
      setState("showHelp", false);
      return setState("search", { open: true, query: "", results: [], index: 0, busy: false });
    }
    const digit = Number(n);
    if (/^[1-9]$/.test(n) && digit <= VIEWS.length)
      return setState("view", VIEWS[digit - 1] ?? "now");
    if (n === "tab") {
      const i = VIEWS.indexOf(state.view);
      return setState(
        "view",
        VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length] ?? "now",
      );
    }
    if (n === "t" && key.shift) return cycleTheme();
    if (n === "u") return setState("units", (u) => (u === "metric" ? "imperial" : "metric"));
    if (n === "r") return props.refresh();
    if (n === "m") return setState("motion", (m) => !m);
    if (n === "s" && !key.shift) return cyclePlace();
    if (state.view === "hourly") {
      const last = HOURS - 1;
      if (n === "left" || n === ",") return setState("hourCursor", (c) => Math.max(0, c - 1));
      if (n === "right" || n === ".") return setState("hourCursor", (c) => Math.min(last, c + 1));
      if (n === "home") return setState("hourCursor", 0);
      if (n === "end") return setState("hourCursor", last);
      const series = SERIES_KEYS.find(([, k]) => k === n);
      if (series && !key.shift) return setState("hourSeries", series[0], (v) => !v);
    }
    if (state.view === "daily") {
      const len = state.report?.forecast?.daily.length ?? 0;
      if (n === "down" || n === "j") return setState("dayIndex", (i) => Math.min(len - 1, i + 1));
      if (n === "up" || n === "k") return setState("dayIndex", (i) => Math.max(0, i - 1));
    }
    if (state.view === "radar") {
      if (n === "space") return radar?.toggle();
      if (n === "i") return setState("radarMode", (m) => (m === "auto" ? "cells" : "auto"));
      if (n === "v") return toggleSatellite();
      if (n === "," || n === "<") return radar?.step(-1);
      if (n === "." || n === ">") return radar?.step(1);
      if (n === "+" || n === "=") return setState("radarZoom", (z) => Math.min(60, z * 1.5));
      if (n === "-" || n === "_") return setState("radarZoom", (z) => Math.max(6, z / 1.5));
    }
    if (state.view === "alerts") {
      const len = state.report?.alerts.length ?? 0;
      if (n === "down" || n === "j") setState("alertIndex", (i) => Math.min(len - 1, i + 1));
      if (n === "up" || n === "k") setState("alertIndex", (i) => Math.max(0, i - 1));
    }
  });

  // Pause every animation while the terminal window is in the background.
  onFocus(() => {
    setState("focused", true);
    setAnimationsPaused(false);
  });
  onBlur(() => {
    setState("focused", false);
    setAnimationsPaused(true);
  });

  onMount(() => {
    renderer.addPostProcessFn(monoFilter);
    // Auto refresh every 10 minutes.
    const id = setInterval(() => props.refresh(), 10 * 60_000);
    onCleanup(() => {
      clearInterval(id);
      renderer.removePostProcessFn(monoFilter);
    });
  });

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={T.bg}>
      <Header state={state} select={(v) => setState("view", v)} />
      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Show
          when={state.report}
          fallback={
            <Splash place={placeLabel(state.location)} error={state.error} motion={state.motion} />
          }
        >
          {(report: () => Report) => (
            <Switch>
              <Match when={state.view === "now"}>
                <NowView state={state} report={report()} />
              </Match>
              <Match when={state.view === "hourly"}>
                <HourlyView state={state} setState={setState} report={report()} />
              </Match>
              <Match when={state.view === "daily"}>
                <DailyView state={state} setState={setState} report={report()} />
              </Match>
              <Match when={state.view === "radar"}>
                <RadarView state={state} http={props.http} controls={(c) => (radar = c)} />
              </Match>
              <Match when={state.view === "map"}>
                <MapView
                  state={state}
                  setState={setState}
                  http={props.http}
                  refresh={props.refresh}
                  controls={(c) => (map = c)}
                />
              </Match>
              <Match when={state.view === "hazards"}>
                <HazardsView state={state} />
              </Match>
              <Match when={state.view === "alerts"}>
                <AlertsView state={state} report={report()} />
              </Match>
              <Match when={state.view === "details"}>
                <DetailsView state={state} report={report()} />
              </Match>
            </Switch>
          )}
        </Show>
      </box>
      <Footer state={state} />
      <Show when={state.showHelp}>
        <Help />
      </Show>
      <Credits />
      <Show when={state.search.open}>
        <SearchOverlay state={state} setState={setState} http={props.http} onPick={switchTo} />
      </Show>
    </box>
  );
}
