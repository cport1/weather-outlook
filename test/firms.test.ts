import { describe, expect, test } from "bun:test";
import { fetchFirmsHotspots, firmsAreaUrl } from "../src/providers/fires.ts";
import type { HttpClient } from "../src/util/http.ts";

const viirs = await Bun.file(`${import.meta.dir}/fixtures/hazards/firms-viirs.csv`).text();
const modis =
  "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n" +
  "1,2,300,1,1,2026-10-06,0009,A,60,6.1NRT,286,9.9,N\n";

function fakeHttp(routes: Record<string, string>): HttpClient & { seen: string[] } {
  const seen: string[] = [];
  const text = async (url: string) => {
    seen.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`unexpected ${url}`);
    return hit[1];
  };
  return {
    seen,
    text,
    json: async (url: string) => JSON.parse(await text(url)),
    bytes: async () => new Uint8Array(),
  } as unknown as HttpClient & { seen: string[] };
}

describe("FIRMS MAP_KEY", () => {
  test("a valid key uses the VIIRS area API", async () => {
    const http = fakeHttp({ "/api/area/csv/KEY123/VIIRS_NOAA20_NRT/world/1": viirs });
    const fires = await fetchFirmsHotspots(http, "KEY123");
    expect(http.seen).toEqual([firmsAreaUrl("KEY123")]);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.kind === "hotspot")).toBe(true);
  });

  test("a rejected key falls back to keyless MODIS and reports why", async () => {
    const http = fakeHttp({ "/api/area/csv/": "Invalid MAP_KEY.", MODIS_C6_1_Global_24h: modis });
    const errors: string[] = [];
    const fires = await fetchFirmsHotspots(http, "bad", (m) => errors.push(m));
    expect(fires).toHaveLength(1);
    expect(errors[0]).toContain("Invalid MAP_KEY");
  });

  test("no key goes straight to MODIS", async () => {
    const http = fakeHttp({ MODIS_C6_1_Global_24h: modis });
    await fetchFirmsHotspots(http);
    expect(http.seen).toHaveLength(1);
    expect(http.seen[0]).toContain("MODIS");
  });
});

test("VIIRS word-form confidence drops low-confidence detections", async () => {
  const { parseFirmsCsv } = await import("../src/providers/fires.ts");
  const csv =
    "latitude,longitude,confidence,frp,acq_date,acq_time\n" +
    "1,2,low,1,2026-10-06,0000\n1,2,nominal,1,2026-10-06,0000\n1,2,high,1,2026-10-06,0000\n";
  expect(parseFirmsCsv(csv).map((f) => f.confidence)).toEqual(["nominal", "high"]);
});
