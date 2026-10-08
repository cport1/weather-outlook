import { describe, expect, test } from "bun:test";
import {
  PROVIDERS,
  providerForUrl,
  recordUse,
  renderAbout,
  trackProviders,
  usedProviders,
} from "../src/attribution.ts";
import {
  chooseSatellite,
  fetchIemFrameTimes,
  iemTime,
  insideConus,
  isFaintN0q,
  mapLimit,
  pickFrameTimes,
} from "../src/providers/radar.ts";
import type { HttpClient } from "../src/util/http.ts";

describe("IEM NEXRAD", () => {
  test("WMS-T time has full seconds", () => {
    expect(iemTime(Date.parse("2026-10-08T03:05:00Z") / 1000)).toBe("2026-10-08T03:05:00Z");
  });

  test("viewport must sit inside CONUS coverage", () => {
    expect(insideConus({ west: -97.5, east: -82.5, south: 24, north: 35 })).toBe(true);
    expect(insideConus({ west: -10, east: 5, south: 45, north: 55 })).toBe(false);
    // Half Pacific: RainViewer instead of a blank half.
    expect(insideConus({ west: -150, east: -110, south: 30, north: 45 })).toBe(false);
  });

  test("frames are thinned to the step, newest last", () => {
    const t0 = 1_800_000_000;
    const scans = Array.from({ length: 30 }, (_, i) => t0 + i * 300); // every 5 min
    const picked = pickFrameTimes(scans, 12, 10);
    expect(picked).toHaveLength(12);
    expect(picked.at(-1)).toBe(t0 + 29 * 300);
    expect((picked[1] ?? 0) - (picked[0] ?? 0)).toBe(600);
  });

  test("frame list comes from radar.py", async () => {
    let url = "";
    const http = {
      json: async (u: string) => {
        url = u;
        return {
          scans: [
            { ts: "2026-10-08T03:50Z" },
            { ts: "2026-10-08T03:55Z" },
            { ts: "2026-10-08T04:00Z" },
          ],
        };
      },
    } as unknown as HttpClient;
    const times = await fetchIemFrameTimes(http, 12, 5, Date.parse("2026-10-08T04:03:00Z"));
    expect(url).toContain("radar.py?operation=list&product=N0Q&radar=USCOMP");
    expect(times.map((t) => iemTime(t))).toEqual([
      "2026-10-08T03:50:00Z",
      "2026-10-08T03:55:00Z",
      "2026-10-08T04:00:00Z",
    ]);
  });

  test("faint clear-air blues are dropped, light rain kept", () => {
    expect(isFaintN0q([79, 132, 182])).toBe(true);
    expect(isFaintN0q([111, 214, 232])).toBe(false);
    expect(isFaintN0q([17, 213, 24])).toBe(false);
  });

  test("mapLimit preserves order and caps concurrency", async () => {
    let inflight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      peak = Math.max(peak, ++inflight);
      await Bun.sleep(5);
      inflight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});

describe("satellite", () => {
  test("picks the satellite that sees the region", () => {
    expect(chooseSatellite(-90).layer).toBe("GOES-East_ABI_GeoColor");
    expect(chooseSatellite(-122).layer).toBe("GOES-West_ABI_GeoColor");
    expect(chooseSatellite(-157).layer).toBe("GOES-West_ABI_GeoColor");
    expect(chooseSatellite(139).layer).toBe("Himawari_AHI_Band13_Clean_Infrared");
    const eu = chooseSatellite(2, Date.parse("2026-10-08T04:00:00Z"));
    expect(eu.layer).toBe("VIIRS_NOAA20_CorrectedReflectance_TrueColor");
    expect(eu.time).toBe("2026-10-07");
  });
});

describe("attribution", () => {
  test("maps request URLs to providers", () => {
    expect(providerForUrl("https://api.open-meteo.com/v1/forecast?x")?.id).toBe("open-meteo");
    expect(providerForUrl("https://tilecache.rainviewer.com/v2/x.png")?.id).toBe("rainviewer");
    expect(providerForUrl("https://example.com")).toBeUndefined();
  });

  test("tracks providers used this session", async () => {
    const inner = { json: async () => ({}) } as unknown as HttpClient;
    await trackProviders(inner).json("https://earthquake.usgs.gov/feed.json", { ttlMs: 1 });
    recordUse("https://gibs.earthdata.nasa.gov/wms");
    const ids = usedProviders().map((p) => p.id);
    expect(ids).toContain("usgs");
    expect(ids).toContain("gibs");
    expect(ids).toContain("natural-earth");
  });

  test("about lists every provider with its license", () => {
    const text = renderAbout("9.9.9", false);
    for (const p of PROVIDERS) {
      expect(text).toContain(p.name);
      expect(text).toContain(p.license);
    }
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("ODbL");
  });
});
