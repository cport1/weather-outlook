import type { Fire } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

const NIFC_INCIDENTS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
// Keyless 24h global MODIS hotspots (~1.5 MB). VIIRS global is ~10 MB, so it's opt-in.
const FIRMS_MODIS_GLOBAL =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv";

interface NifcFeature {
  geometry: { coordinates: [number, number] } | null;
  properties: {
    IncidentName: string;
    IncidentSize: number | null;
    PercentContained: number | null;
    FireDiscoveryDateTime: number | null;
    POOState?: string;
    UniqueFireIdentifier: string;
  };
}

export function parseNifc(raw: { features: NifcFeature[] }): Fire[] {
  return raw.features
    .filter((f) => f.geometry)
    .map((f) => ({
      id: f.properties.UniqueFireIdentifier,
      provider: "nifc",
      name: f.properties.IncidentName,
      lon: f.geometry?.coordinates[0] ?? 0,
      lat: f.geometry?.coordinates[1] ?? 0,
      acres: f.properties.IncidentSize ?? undefined,
      containment: f.properties.PercentContained ?? undefined,
      discovered: f.properties.FireDiscoveryDateTime
        ? new Date(f.properties.FireDiscoveryDateTime).toISOString()
        : undefined,
      kind: "incident" as const,
    }))
    .sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
}

/** US wildfire incidents (prescribed burns excluded), largest first. */
export async function fetchNifcIncidents(http: HttpClient, minAcres = 0): Promise<Fire[]> {
  const where = encodeURIComponent(
    `IncidentTypeCategory='WF'${minAcres > 0 ? ` AND IncidentSize>=${minAcres}` : ""}`,
  );
  const fields =
    "IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,POOState,UniqueFireIdentifier";
  const raw = await http.json<{ features: NifcFeature[] }>(
    `${NIFC_INCIDENTS}?where=${where}&outFields=${fields}&f=geojson&resultRecordCount=2000`,
    { ttlMs: 15 * 60_000, timeoutMs: 20_000 },
  );
  return parseNifc(raw);
}

/** Parse FIRMS CSV (MODIS or VIIRS column layouts). */
export function parseFirmsCsv(csv: string, minConfidence = 50): Fire[] {
  const lines = csv.trim().split("\n");
  const header = lines.shift()?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);
  const iLat = col("latitude");
  const iLon = col("longitude");
  const iFrp = col("frp");
  const iConf = col("confidence");
  const iDate = col("acq_date");
  const iTime = col("acq_time");
  const out: Fire[] = [];
  for (const [n, line] of lines.entries()) {
    const c = line.split(",");
    const conf = c[iConf] ?? "";
    // MODIS confidence is 0-100; VIIRS uses l/n/h.
    const numeric = Number(conf);
    const ok = Number.isFinite(numeric) ? numeric >= minConfidence : conf !== "l";
    if (!ok) continue;
    const t = c[iTime] ?? "0000";
    out.push({
      id: `firms-${n}`,
      provider: "firms",
      lat: Number(c[iLat]),
      lon: Number(c[iLon]),
      frp: Number(c[iFrp]) || undefined,
      confidence: conf,
      discovered: `${c[iDate]}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`,
      kind: "hotspot",
    });
  }
  return out;
}

export async function fetchFirmsHotspots(http: HttpClient): Promise<Fire[]> {
  const csv = await http.text(FIRMS_MODIS_GLOBAL, { ttlMs: 60 * 60_000, timeoutMs: 30_000 });
  return parseFirmsCsv(csv);
}
