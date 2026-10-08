import { type ASCIIFontName, measureText } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { hex, lerp, type RGB } from "../../render/color.ts";
import { hexOf } from "../format.ts";
import { T } from "../theme.ts";

const LOGO = "weather-outlook";
const STOPS: RGB[] = [
  hex("#7dd3fc"),
  hex("#a78bfa"),
  hex("#f472b6"),
  hex("#fbbf24"),
  hex("#7dd3fc"),
];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function gradient(t: number): RGB {
  const x = (((t % 1) + 1) % 1) * (STOPS.length - 1);
  const i = Math.floor(x);
  return lerp(
    STOPS[i] ?? STOPS[0] ?? [255, 255, 255],
    STOPS[i + 1] ?? STOPS[0] ?? [255, 255, 255],
    x - i,
  );
}

/** Pick the largest font that fits `width`. */
export function fitFont(
  text: string,
  width: number,
  fonts: ASCIIFontName[],
): ASCIIFontName | undefined {
  return fonts.find((f) => measureText({ text, font: f }).width <= width);
}

/** Boot splash: gradient logo (shimmering when motion is on) while the first fetch runs. */
export function Splash(props: { place: string; error?: string; motion: boolean }) {
  const dims = useTerminalDimensions();
  const [tick, setTick] = createSignal(0);
  const id = setInterval(() => props.motion && setTick((t) => t + 1), 80);
  onCleanup(() => clearInterval(id));
  const font = () => fitFont(LOGO, dims().width - 4, ["block", "slick", "tiny"]);
  const letters = [...LOGO];
  const shift = () => (props.motion ? tick() / 60 : 0);
  return (
    <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
      <Show
        when={font()}
        fallback={
          <text wrapMode="none">
            <For each={letters}>
              {(ch, i) => (
                <span style={{ fg: hexOf(gradient(i() / letters.length - shift())) }}>{ch}</span>
              )}
            </For>
          </text>
        }
      >
        {(f: () => ASCIIFontName) => (
          <box flexDirection="row">
            <For each={letters}>
              {(ch, i) => (
                <ascii_font
                  text={ch}
                  font={f()}
                  color={hexOf(gradient(i() / letters.length - shift()))}
                />
              )}
            </For>
          </box>
        )}
      </Show>
      <text wrapMode="none" fg={props.error ? T.danger : T.dim}>
        {props.error
          ? `✗ ${props.error}`
          : `${SPINNER[tick() % SPINNER.length]} fetching the sky over ${props.place}…`}
      </text>
    </box>
  );
}
