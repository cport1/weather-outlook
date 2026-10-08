import type { Storm, TrackPoint } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";
import { categoryFromKt, compassPoint, dtgToIso } from "./nhc.ts";

/**
 * Joint Typhoon Warning Center: West Pacific, Indian Ocean and Southern
 * Hemisphere cyclones that NHC doesn't cover. The RSS lists active warnings;
 * each warning's plain-text bulletin (`{id}web.txt`) carries the current fix
 * and forecast track, so no KMZ unzipping is needed. Past positions come
 * from ATCF best-track files (NHC FTP for AL/EP/CP, UCAR RAL mirror otherwise).
 */

const RSS = "https://www.metoc.navy.mil/jtwc/rss/jtwc.rss";
const PRODUCTS = "https://www.metoc.navy.mil/jtwc/products";

export interface JtwcWarningRef {
  /** Product id, e.g. "wp2726" (basin, number, 2-digit year). */
  product: string;
  basin: string;
  number: string;
  year: number;
  classification: string;
  name: string;
  warning: number;
}

const TITLE =
  /(Super Typhoon|Typhoon|Tropical Storm|Tropical Depression|Tropical Cyclone|Hurricane|Subtropical Storm|Subtropical Depression)\s+(\d{2}[A-Z])\s+\(([^)]*)\)\s+Warning\s+#(\d+)[\s\S]*?products\/([a-z]{2})(\d{2})(\d{2})web\.txt/g;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

export function parseJtwcRss(xml: string): JtwcWarningRef[] {
  const out: JtwcWarningRef[] = [];
  for (const m of xml.matchAll(TITLE)) {
    const [, cls, , name, warning, basin, num, yy] = m;
    if (!basin || !num || !yy) continue;
    out.push({
      product: `${basin}${num}${yy}`,
      basin: basin.toUpperCase(),
      number: num,
      year: 2000 + Number(yy),
      classification: cls ?? "Tropical Cyclone",
      name: titleCase(name || `${num}${basin.toUpperCase()}`),
      warning: Number(warning),
    });
  }
  return out;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Resolve a JTWC "DDHHMMZ" stamp against the bulletin's issue date. */
export function resolveDdhhmm(stamp: string, ref: Date): string {
  const dd = Number(stamp.slice(0, 2));
  const hh = Number(stamp.slice(2, 4));
  const mm = Number(stamp.slice(4, 6));
  let y = ref.getUTCFullYear();
  let mo = ref.getUTCMonth();
  const diff = dd - ref.getUTCDate();
  if (diff < -15) mo += 1;
  else if (diff > 15) mo -= 1;
  if (mo > 11) {
    mo = 0;
    y += 1;
  } else if (mo < 0) {
    mo = 11;
    y -= 1;
  }
  return new Date(Date.UTC(y, mo, dd, hh, mm)).toISOString();
}

const coord = (v: string, hemi: string) => (hemi === "S" || hemi === "W" ? -1 : 1) * Number(v);

export interface JtwcWarning {
  lat: number;
  lon: number;
  time?: string;
  windKt?: number;
  pressureMb?: number;
  movement?: string;
  forecast: TrackPoint[];
}

/** Parse a JTWC warning bulletin (`wp2726web.txt`). */
export function parseJtwcWarning(text: string, now = new Date()): JtwcWarning | undefined {
  // Issue date from the remarks ("08OCT26."), used to resolve DDHHMMZ stamps.
  const d = text.match(/\b(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\./);
  const ref = d
    ? new Date(Date.UTC(2000 + Number(d[3]), MONTHS.indexOf(d[2] ?? ""), Number(d[1])))
    : now;
  const pos = text.match(
    /WARNING POSITION:\s*\n\s*(\d{6})Z\s+---\s+NEAR\s+(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])/,
  );
  if (!pos) return undefined;
  const [, stamp, la, ns, lo, ew] = pos;
  const after = text.slice(pos.index ?? 0);
  const wind = after.match(/MAX SUSTAINED WINDS - (\d+) KT/);
  const move = after.match(/MOVEMENT PAST SIX HOURS - (\d+) DEGREES AT (\d+) KTS/);
  const pres = text.match(/MINIMUM\s+CENTRAL\s+PRESSURE\s+AT\s+\d{6}Z\s+IS\s+(\d+)\s+MB/);
  const forecast: TrackPoint[] = [];
  const fc =
    /(\d+) HRS, VALID AT:\s*\n\s*(\d{6})Z\s+---\s+(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])[^\n]*\n\s*MAX SUSTAINED WINDS - (\d+) KT/g;
  for (const m of text.matchAll(fc)) {
    const kt = Number(m[7]);
    forecast.push({
      time: resolveDdhhmm(m[2] ?? "", ref),
      lat: coord(m[3] ?? "0", m[4] ?? "N"),
      lon: coord(m[5] ?? "0", m[6] ?? "E"),
      windKt: kt,
      category: categoryFromKt(kt),
      forecast: true,
    });
  }
  const windKt = wind ? Number(wind[1]) : undefined;
  return {
    lat: coord(la ?? "0", ns ?? "N"),
    lon: coord(lo ?? "0", ew ?? "E"),
    time: stamp ? resolveDdhhmm(stamp, ref) : undefined,
    windKt,
    pressureMb: pres ? Number(pres[1]) : undefined,
    movement: move
      ? `${compassPoint(Number(move[1]))} ${Math.round(Number(move[2]) * 1.15078)} mph`
      : undefined,
    forecast,
  };
}

/** Parse an ATCF best-track (b-deck) file into past positions, one per synoptic time. */
export function parseAtcfBestTrack(dat: string): TrackPoint[] {
  const seen = new Map<string, TrackPoint>();
  for (const line of dat.split("\n")) {
    const f = line.split(",").map((x) => x.trim());
    const dtg = f[2];
    const lat = f[6]?.match(/^(\d+)([NS])$/);
    const lon = f[7]?.match(/^(\d+)([EW])$/);
    if (!dtg || !lat || !lon || seen.has(dtg)) continue;
    const kt = Number(f[8]);
    const mb = Number(f[9]);
    seen.set(dtg, {
      time: dtgToIso(Number(dtg)),
      lat: coord(String(Number(lat[1]) / 10), lat[2] ?? "N"),
      lon: coord(String(Number(lon[1]) / 10), lon[2] ?? "E"),
      windKt: kt > 0 ? kt : undefined,
      pressureMb: mb > 0 ? mb : undefined,
      category: categoryFromKt(kt > 0 ? kt : undefined),
      forecast: false,
    });
  }
  return [...seen.values()].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

const RAL_DIR: Record<string, string> = {
  WP: "northwestpacific",
  IO: "northindian",
  SH: "southernhemisphere",
};

/** Where to find the ATCF best track for a storm, if anywhere. */
export function bestTrackUrl(basin: string, number: string, year: number): string | undefined {
  const b = basin.toLowerCase();
  const file = `b${b}${number}${year}.dat`;
  if (b === "al" || b === "ep" || b === "cp") return `https://ftp.nhc.noaa.gov/atcf/btk/${file}`;
  const dir = RAL_DIR[basin.toUpperCase()];
  return dir
    ? `https://hurricanes.ral.ucar.edu/realtime/plots/${dir}/${year}/${b}${number}${year}/${file}`
    : undefined;
}

/** Active JTWC storms with forecast track and (where available) best-track history. */
export async function fetchJtwcStorms(http: HttpClient, now = new Date()): Promise<Storm[]> {
  const xml = await http.text(RSS, { ttlMs: 15 * 60_000, timeoutMs: 15_000 });
  const refs = parseJtwcRss(xml);
  const storms = await Promise.all(
    refs.map(async (r): Promise<Storm | undefined> => {
      const text = await http
        .text(`${PRODUCTS}/${r.product}web.txt`, { ttlMs: 30 * 60_000, timeoutMs: 15_000 })
        .catch(() => undefined);
      const w = text ? parseJtwcWarning(text, now) : undefined;
      if (!w) return undefined;
      const btUrl = bestTrackUrl(r.basin, r.number, r.year);
      const past = btUrl
        ? await http
            .text(btUrl, { ttlMs: 60 * 60_000, timeoutMs: 15_000 })
            .then(parseAtcfBestTrack)
            .catch(() => [])
        : [];
      const current: TrackPoint = {
        time: w.time,
        lat: w.lat,
        lon: w.lon,
        windKt: w.windKt,
        pressureMb: w.pressureMb,
        category: categoryFromKt(w.windKt),
        forecast: false,
      };
      const cutoff = w.time ? Date.parse(w.time) : Number.POSITIVE_INFINITY;
      const before = past.filter((p) => p.time !== undefined && Date.parse(p.time) < cutoff);
      return {
        id: `jtwc-${r.product}`,
        provider: "jtwc",
        name: r.name,
        basin: r.basin,
        classification: r.classification,
        category: categoryFromKt(w.windKt),
        lat: w.lat,
        lon: w.lon,
        windKt: w.windKt,
        pressureMb: w.pressureMb,
        movement: w.movement,
        updated: w.time,
        track: [...before, current, ...w.forecast],
      };
    }),
  );
  return storms.filter((s): s is Storm => Boolean(s));
}
