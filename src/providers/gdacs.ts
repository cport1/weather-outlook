import type { Storm } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";
import { categoryFromKt } from "./nhc.ts";

interface GdacsFeature {
  geometry: { type: string; coordinates: [number, number] };
  properties: {
    eventid: number;
    eventtype: string;
    name: string;
    alertlevel: string;
    iscurrent?: string | boolean;
    todate?: string;
    severitydata?: { severity?: number; severityunit?: string };
  };
}

/** Global tropical cyclones from GDACS (single current position each, no track). */
export async function fetchGdacsCyclones(http: HttpClient, now = new Date()): Promise<Storm[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 7 * 86_400_000);
  const raw = await http.json<{ features: GdacsFeature[] }>(
    `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromDate=${day(from)}&toDate=${day(now)}`,
    { ttlMs: 30 * 60_000, timeoutMs: 20_000 },
  );
  return raw.features
    .filter((f) => f.geometry?.type === "Point" && String(f.properties.iscurrent) === "true")
    .map((f) => {
      const p = f.properties;
      const kmh = p.severitydata?.severityunit === "km/h" ? p.severitydata.severity : undefined;
      const kt = kmh !== undefined ? Math.round(kmh / 1.852) : undefined;
      const name = p.name.replace(/^Tropical Cyclone\s+/i, "").replace(/-\d+$/, "");
      return {
        id: `gdacs-${p.eventid}`,
        provider: "gdacs",
        name: name.charAt(0) + name.slice(1).toLowerCase(),
        classification: `Tropical Cyclone (${p.alertlevel} alert)`,
        category: categoryFromKt(kt),
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        windKt: kt,
        updated: p.todate,
        track: [],
      };
    });
}
