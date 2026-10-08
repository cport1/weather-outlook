import { expect, test } from "bun:test";
import { NativeImage } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { hex } from "../src/render/color.ts";
import { createMapRaster } from "../src/render/raster.ts";
import { DEFAULT_THEME } from "../src/render/worldmap.ts";

test("map raster renders land, ocean, coast and marker pixels", () => {
  const r = createMapRaster(200, 120, { lon: -90, lat: 30, zoom: 24 }, DEFAULT_THEME);
  const px = r.frame((lon) => (lon > -88 && lon < -87 ? hex("#ff0000") : undefined), {
    lon: -90,
    lat: 30,
    color: hex("#00ffff"),
  });
  const colors = new Set<string>();
  for (let i = 0; i < px.length; i += 4) colors.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  expect(colors.has(DEFAULT_THEME.land.join(","))).toBe(true);
  expect(colors.has(DEFAULT_THEME.ocean.join(","))).toBe(true);
  expect(colors.has(DEFAULT_THEME.coast.join(","))).toBe(true);
  expect(colors.has("255,0,0")).toBe(true);
  expect(colors.has("0,255,255")).toBe(true);
});

test("a raster frame can be shown through OpenTUI's image renderable (kitty)", async () => {
  const r = createMapRaster(160, 80, { lon: 0, lat: 0, zoom: 1 }, DEFAULT_THEME);
  const img = NativeImage.fromRgba(r.frame(), r.width, r.height);
  const t = await testRender(
    () => <image width={40} height={10} source={img} protocol="kitty" fit="fill" />,
    {
      width: 40,
      height: 10,
    },
  );
  await t.renderOnce();
  expect(img.width).toBe(160);
  img.dispose();
});
