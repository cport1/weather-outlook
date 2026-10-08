import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { testRender } from "@opentui/solid";
import pkg from "../package.json" with { type: "json" };
import { App } from "../src/tui/app.tsx";
import { createAppStore, type View } from "../src/tui/store.ts";
import { resolveThemeName, setTheme } from "../src/tui/theme.ts";
import { FIXTURE_NOW, fixtureHazards, fixtureReport, offlineHttp } from "./fixtures/report.ts";

// Headless frames of every view from fixture data (no network, frozen clock,
// no motion) so layout regressions show up as snapshot diffs.

type Setup = Awaited<ReturnType<typeof testRender>>;
let open: Setup | undefined;

beforeAll(() => setSystemTime(FIXTURE_NOW));
afterAll(() => setSystemTime());
afterEach(() => {
  open?.renderer.destroy();
  open = undefined;
  setTheme("midnight");
});

async function mount(width: number, height: number, view: View = "now") {
  const report = fixtureReport();
  const [state, setState] = createAppStore({
    location: report.location,
    units: "imperial",
    motion: false,
  });
  setState({ report, hazards: fixtureHazards(), loading: false, lastUpdated: Date.now(), view });
  const t = await testRender(
    () => (
      <App
        http={offlineHttp}
        state={state}
        setState={setState}
        refresh={() => {}}
        quit={() => {}}
      />
    ),
    { width, height },
  );
  open = t;
  await t.renderOnce();
  await t.renderOnce();
  return { t, state, setState };
}

const OWN_VIEWS: View[] = ["now", "hourly", "daily", "alerts", "details"];
const SIZES: Array<[number, number]> = [
  [80, 24],
  [160, 48],
];

describe.each(SIZES)("%ix%i", (width, height) => {
  for (const view of OWN_VIEWS) {
    test(`${view} view`, async () => {
      const { t } = await mount(width, height, view);
      const frame = t.captureCharFrame();
      expect(frame.split("\n").length).toBeGreaterThanOrEqual(height);
      expect(frame).toMatchSnapshot();
    });
  }

  // Map/hazards/radar are owned by other workstreams and change often, so
  // they get smoke checks rather than exact frames.
  for (const view of ["map", "hazards", "radar"] as View[]) {
    test(`${view} view renders`, async () => {
      const { t } = await mount(width, height, view);
      const frame = t.captureCharFrame();
      expect(frame).toContain("◆");
      expect(frame.replace(/\s/g, "").length).toBeGreaterThan(width);
    });
  }

  test("boot splash while the first fetch runs", async () => {
    const { t, setState } = await mount(width, height);
    setState("report", undefined);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("fetching the sky over Denver");
    expect(frame).toContain(`weather-outlook ${pkg.version}`);
    // The splash shows the package version, which every release bumps.
    const stable = frame
      .split("\n")
      .map((line) => (line.includes(`weather-outlook ${pkg.version}`) ? "<version line>" : line))
      .join("\n");
    expect(stable).toMatchSnapshot();
  });
});

describe("details panels", () => {
  for (const [panel, presses, marker] of [
    ["models", 1, "forecast confidence"],
    ["marine", 2, "tides"],
    ["air", 3, "US AQI"],
    ["climate", 4, "normals"],
  ] as const) {
    test(`160x48 ${panel} panel`, async () => {
      const { t } = await mount(160, 48, "details");
      for (let i = 0; i < presses; i++) t.mockInput.pressArrow("right");
      await t.renderOnce();
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain(marker);
      expect(frame).toMatchSnapshot();
    });
  }

  test("key 8 opens Details; its tab fits the header at every width", async () => {
    for (const [w, h, idle] of [
      [80, 24, "8 More"],
      [100, 30, "8 More"],
      [160, 48, "8 Details"],
    ] as const) {
      const { t, state } = await mount(w, h, "now");
      const before = t.captureCharFrame().split("\n")[0] ?? "";
      expect(before).toContain(idle);
      t.mockInput.pressKey("8");
      await t.renderOnce();
      expect(state.view).toBe("details");
      const after = t.captureCharFrame().split("\n")[0] ?? "";
      expect(after).toContain("8 Details");
      expect(after).toContain("1 ");
      open?.renderer.destroy();
      open = undefined;
    }
  });

  test("clicking the Details tab switches view", async () => {
    const { t, state } = await mount(160, 48, "now");
    const row = t.captureCharFrame().split("\n")[0] ?? "";
    const x = row.indexOf("8 Details");
    expect(x).toBeGreaterThan(0);
    await t.mockMouse.click(x + 2, 0);
    await t.renderOnce();
    expect(state.view).toBe("details");
  });
});

describe("no-color", () => {
  test("mono theme is forced by NO_COLOR and drains every hue", async () => {
    expect(resolveThemeName("solarized", { NO_COLOR: "1" })).toBe("mono");
    setTheme(resolveThemeName(undefined, { NO_COLOR: "1" }));
    for (const view of ["now", "hourly", "daily", "map"] as View[]) {
      const { t } = await mount(120, 36, view);
      for (const line of t.captureSpans().lines) {
        for (const span of line.spans) {
          for (const c of [span.fg, span.bg]) {
            const [r, g, b, a] = c.toInts();
            if (a === 0) continue;
            expect(Math.abs(r - g) + Math.abs(g - b)).toBeLessThanOrEqual(2);
          }
        }
      }
      open?.renderer.destroy();
      open = undefined;
    }
  });

  test("80x24 now view in mono", async () => {
    setTheme("mono");
    const { t } = await mount(80, 24, "now");
    expect(t.captureCharFrame()).toMatchSnapshot();
  });
});

describe("interaction", () => {
  test("clicking a header tab switches view", async () => {
    const { t, state } = await mount(160, 48, "now");
    const frame = t.captureCharFrame();
    const row = frame.split("\n")[0] ?? "";
    const x = row.indexOf("3 10-Day");
    expect(x).toBeGreaterThan(0);
    await t.mockMouse.click(x + 2, 0);
    await t.renderOnce();
    expect(state.view).toBe("daily");
  });

  test("hourly cursor moves with arrows and series toggle off", async () => {
    const { t, state } = await mount(160, 48, "hourly");
    t.mockInput.pressArrow("right");
    t.mockInput.pressArrow("right");
    await t.renderOnce();
    expect(state.hourCursor).toBe(2);
    t.mockInput.pressKey("w");
    await t.renderOnce();
    expect(state.hourSeries.wind).toBe(false);
    expect(t.captureCharFrame()).not.toContain("│ wind ");
  });

  test("`/` opens location search, esc closes it, q does not quit while typing", async () => {
    let quit = false;
    const report = fixtureReport();
    const [state, setState] = createAppStore({
      location: report.location,
      units: "imperial",
      motion: false,
    });
    setState({ report, loading: false });
    const t = await testRender(
      () => (
        <App
          http={offlineHttp}
          state={state}
          setState={setState}
          refresh={() => {}}
          quit={() => {
            quit = true;
          }}
        />
      ),
      { width: 100, height: 30 },
    );
    open = t;
    await t.renderOnce();
    t.mockInput.pressKey("/");
    await t.renderOnce();
    expect(state.search.open).toBe(true);
    expect(t.captureCharFrame()).toContain("search location");
    t.mockInput.pressKey("q");
    await t.renderOnce();
    expect(state.search.query).toBe("q");
    expect(quit).toBe(false);
    t.mockInput.pressEscape();
    await Bun.sleep(60);
    await t.renderOnce();
    expect(state.search.open).toBe(false);
  });

  test("Tab in map inspect mode stays with the map", async () => {
    const { t, state } = await mount(160, 48, "map");
    t.mockInput.pressKey("i");
    await t.renderOnce();
    t.mockInput.pressTab();
    await t.renderOnce();
    expect(state.view).toBe("map");
  });

  test("`s` cycles through saved places", async () => {
    const { t, state, setState } = await mount(100, 30, "now");
    setState("saved", [{ name: "Oslo", lat: 59.91, lon: 10.75, source: "config" }]);
    t.mockInput.pressKey("s");
    await t.renderOnce();
    expect(state.location.name).toBe("Oslo");
    t.mockInput.pressKey("s");
    await t.renderOnce();
    expect(state.location.name).toBe("Denver");
  });
});
