#!/usr/bin/env bun
/**
 * Refresh the recorded API responses under test/fixtures/.
 *
 *   bun scripts/record-fixtures.ts            # everything
 *   bun scripts/record-fixtures.ts nws ipwho  # just fixtures whose name contains these
 *
 * Responses are fetched with the app's own User-Agent and stored verbatim,
 * except IP-geolocation answers, which are rewritten to a documentation IP in
 * Denver so nobody's address ends up in the repo.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES } from "../test/fixtures/manifest.ts";
import { type HttpClient, USER_AGENT } from "../src/util/http.ts";

const DIR = join(import.meta.dir, "..", "test", "fixtures");

const DENVER = {
  city: "Denver",
  region: "Colorado",
  lat: 39.7392,
  lon: -104.9903,
  timezone: "America/Denver",
};

/** Replace anything that identifies the machine that recorded the fixture. */
function scrubIp(name: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw, ip: "203.0.113.7" };
  for (const k of ["hostname", "postal", "network", "org", "asn", "connection", "organization"]) {
    delete out[k];
  }
  delete out.organization_name;
  if ("city" in out) out.city = DENVER.city;
  if ("region" in out) out.region = DENVER.region;
  if ("region_code" in out) out.region_code = "CO";
  if ("utc_offset" in out) out.utc_offset = "-0600";
  if ("postal" in raw) delete out.postal;
  if (name === "ipinfo") out.loc = `${DENVER.lat},${DENVER.lon}`;
  if (name === "geojs") {
    out.latitude = String(DENVER.lat);
    out.longitude = String(DENVER.lon);
  } else if ("latitude" in out) {
    out.latitude = DENVER.lat;
    out.longitude = DENVER.lon;
  }
  if (typeof out.timezone === "string") out.timezone = DENVER.timezone;
  else if (out.timezone && typeof out.timezone === "object") {
    out.timezone = { id: DENVER.timezone };
  }
  return out;
}

/** NWS point queries are often empty; record a busy state instead, trimmed to a few alerts. */
async function nwsAlerts(): Promise<unknown> {
  for (const area of ["AK", "TX", "CA", "FL", "MT", "WA", "CO", "NY"]) {
    const res = await fetch(`https://api.weather.gov/alerts/active?area=${area}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
    });
    const body = (await res.json()) as { features: unknown[] };
    if (body.features.length) return { ...body, features: body.features.slice(0, 4) };
  }
  throw new Error("No active NWS alerts in any sampled state; try again later.");
}

/** An HttpClient that really fetches and remembers the raw JSON of the last response. */
function recorder(): { http: HttpClient; last: () => unknown } {
  let raw: unknown;
  const text = async (url: string) => {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/geo+json, */*" },
    });
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const body = await res.text();
    raw = JSON.parse(body);
    return body;
  };
  const http: HttpClient = {
    text,
    async json<T>(url: string) {
      return JSON.parse(await text(url)) as T;
    },
    async bytes() {
      throw new Error("binary fixtures are not supported");
    },
  };
  return { http, last: () => raw };
}

const filters = process.argv.slice(2);
await mkdir(DIR, { recursive: true });
for (const f of FIXTURES) {
  if (filters.length && !filters.some((x) => f.name.includes(x))) continue;
  let body: unknown;
  if (f.name === "nws-alerts") {
    body = await nwsAlerts();
  } else {
    const rec = recorder();
    await f.record(rec.http);
    body = rec.last();
    if (f.transform) body = f.transform(body);
    if (f.kind === "ip") body = scrubIp(f.name, body as Record<string, unknown>);
  }
  await writeFile(join(DIR, `${f.name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`recorded ${f.name}.json`);
}
