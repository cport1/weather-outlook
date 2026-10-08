import type { Condition } from "../../domain/types.ts";
import { conditionArtFrame } from "../../render/art.ts";
import type { DrawApi } from "../cell-canvas.ts";
import { theme } from "../theme.ts";

const FRAME_MS = 450;

/** 13×5 condition art that animates (rays spin, clouds drift, bolts flicker) when motion is on. */
export function AnimatedIcon(props: { condition: Condition; isDay: boolean; motion: boolean }) {
  let clock = 0;
  const draw = (api: DrawApi, _w: number, _h: number, dt: number) => {
    if (props.motion) clock += dt;
    const frame = props.motion ? Math.floor(clock / FRAME_MS) : 0;
    const art = conditionArtFrame(props.condition, props.isDay, frame);
    art.forEach((runs, row) => {
      let x = 0;
      for (const [text, color] of runs) {
        for (const ch of text) {
          if (ch !== " ") api.cell(x, row, ch, color ?? theme.text);
          x++;
        }
      }
    });
  };
  return <cell_canvas live={props.motion} width={13} height={5} flexShrink={0} draw={draw} />;
}
