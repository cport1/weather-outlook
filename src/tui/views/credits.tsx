import { createSignal, For, Show } from "solid-js";
import { usedProviders } from "../../attribution.ts";
import { T } from "../theme.ts";

// Module-level so the overlay can be toggled from the global key handler without store changes.
const [open, setOpen] = createSignal(false);
export const creditsOpen = open;
export const toggleCredits = () => setOpen((v) => !v);
export const closeCredits = () => setOpen(false);

/** Data credits overlay (`!`): every provider contacted this session, with its license. */
export function Credits() {
  // Snapshot on open; providers used later appear the next time it's opened.
  const providers = () => (open() ? usedProviders() : []);
  const nameW = () => Math.max(0, ...providers().map((p) => p.name.length)) + 2;
  const licW = () => Math.max(0, ...providers().map((p) => p.license.length)) + 2;
  return (
    <Show when={open()}>
      <box
        position="absolute"
        top={2}
        left={4}
        right={4}
        border
        borderStyle="double"
        borderColor={T.accent}
        backgroundColor={T.panel}
        title=" data credits · this session "
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        zIndex={11}
      >
        <For each={providers()}>
          {(p) => (
            <text wrapMode="none">
              <span style={{ fg: T.accent }}>{p.name.padEnd(nameW())}</span>
              <span style={{ fg: T.dim }}>{p.license.padEnd(licW())}</span>
              <span style={{ fg: T.text }}>{p.attribution}</span>
            </text>
          )}
        </For>
        <text fg={T.faint}>full list: weather-outlook about · ! or esc to close</text>
      </box>
    </Show>
  );
}
