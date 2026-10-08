import { useTerminalDimensions } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { Location } from "../../domain/types.ts";
import { hintTerms, parseCoords } from "../../providers/location.ts";
import { geocode } from "../../providers/open-meteo.ts";
import type { HttpClient } from "../../util/http.ts";
import type { AppState } from "../store.ts";
import { T } from "../theme.ts";

export const SEARCH_DEBOUNCE_MS = 250;

/** Geocode suggestions for a partial query; "City, ST" hints rank matching regions first. */
export async function searchLocations(http: HttpClient, query: string): Promise<Location[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const coords = parseCoords(q);
  if (coords) {
    return [
      { name: `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`, ...coords, source: "coords" },
    ];
  }
  const [head = q, ...rest] = q.split(",").map((s) => s.trim());
  const results = await geocode(http, head, 8);
  if (!rest.join("").length) return results;
  const terms = hintTerms(rest.join(" "));
  return results
    .map((r, i) => {
      const hay = [r.region, r.country, r.countryCode]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .split(/\s+/);
      return { r, i, score: terms.filter((t) => hay.includes(t)).length };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.r);
}

export const placeLabel = (l: Location) =>
  [l.name, l.region, l.countryCode].filter(Boolean).join(", ");

/**
 * `/` overlay: an input with live, debounced geocode suggestions. Arrow keys
 * and Enter are handled by the app's key handler (see App) so focus stays here.
 */
export function SearchOverlay(props: {
  state: AppState;
  setState: SetStoreFunction<AppState>;
  http: HttpClient;
  onPick: (loc: Location) => void;
}) {
  const dims = useTerminalDimensions();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  onCleanup(() => timer && clearTimeout(timer));

  const onInput = (value: string) => {
    props.setState("search", { query: value, index: 0 });
    if (timer) clearTimeout(timer);
    const mine = ++seq;
    if (value.trim().length < 2) {
      props.setState("search", { results: [], busy: false });
      return;
    }
    props.setState("search", "busy", true);
    timer = setTimeout(async () => {
      try {
        const results = await searchLocations(props.http, value);
        if (mine === seq) props.setState("search", { results, busy: false, index: 0 });
      } catch {
        if (mine === seq) props.setState("search", { results: [], busy: false });
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  const width = () => Math.min(60, dims().width - 4);
  // With an empty query, offer recent + saved locations instead.
  const suggestions = () =>
    props.state.search.query.trim().length >= 2
      ? props.state.search.results
      : [...props.state.recent, ...props.state.saved];

  return (
    <box
      position="absolute"
      top={2}
      left={Math.max(0, Math.floor((dims().width - width()) / 2))}
      width={width()}
      border
      borderStyle="rounded"
      borderColor={T.accent}
      backgroundColor={T.panel}
      title=" search location "
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      zIndex={20}
    >
      <box flexDirection="row" height={1}>
        <text fg={T.accent} wrapMode="none">
          {"/ "}
        </text>
        <input
          flexGrow={1}
          focused
          placeholder="city, region or lat,lon"
          backgroundColor={T.panel}
          focusedBackgroundColor={T.panel}
          textColor={T.text}
          focusedTextColor={T.text}
          placeholderColor={T.faint}
          onInput={onInput}
        />
      </box>
      <Show when={props.state.search.busy}>
        <text fg={T.dim}>searching…</text>
      </Show>
      <Show
        when={suggestions().length}
        fallback={
          <text fg={T.faint} wrapMode="none">
            {props.state.search.query.trim().length >= 2 && !props.state.search.busy
              ? "no matches"
              : "type to search · ↑↓ pick · enter switch · esc close"}
          </text>
        }
      >
        <Show when={props.state.search.query.trim().length < 2}>
          <text fg={T.dim}>recent & saved</text>
        </Show>
        <For each={suggestions().slice(0, 8)}>
          {(loc, i) => {
            const on = () => i() === props.state.search.index;
            return (
              <text
                wrapMode="none"
                bg={on() ? T.border : T.panel}
                onMouseDown={() => props.onPick(loc)}
                onMouseOver={() => props.setState("search", "index", i())}
              >
                <span style={{ fg: on() ? T.accent : T.dim, bg: on() ? T.border : T.panel }}>
                  {on() ? "▸ " : "  "}
                </span>
                <span style={{ fg: T.text, bg: on() ? T.border : T.panel }}>{placeLabel(loc)}</span>
                <span style={{ fg: T.faint, bg: on() ? T.border : T.panel }}>
                  {`  ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`}
                </span>
              </text>
            );
          }}
        </For>
      </Show>
    </box>
  );
}

/** Suggestions currently listed (same logic as the overlay), for keyboard picking. */
export function currentSuggestions(state: AppState): Location[] {
  return (
    state.search.query.trim().length >= 2 ? state.search.results : [...state.recent, ...state.saved]
  ).slice(0, 8);
}
