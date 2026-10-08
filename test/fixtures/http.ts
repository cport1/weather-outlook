import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "../../src/util/http.ts";
import { FIXTURES } from "./manifest.ts";

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dir, `${name}.json`), "utf8")) as T;
}

/**
 * Offline HttpClient serving recorded fixtures by host + path.
 * `fail` lists fixture names (or hosts) that should behave as if unreachable,
 * and `requests` records every URL asked for.
 */
export function fixtureHttp(opts: { fail?: string[]; override?: Record<string, unknown> } = {}) {
  const requests: string[] = [];
  const text = async (url: string): Promise<string> => {
    requests.push(url);
    const u = new URL(url);
    const key = `${u.host}${u.pathname}`;
    const f =
      FIXTURES.find((x) => x.match === key) ??
      FIXTURES.filter((x) => x.prefix && key.startsWith(x.match)).sort(
        (a, b) => b.match.length - a.match.length,
      )[0];
    if (!f) throw new Error(`no fixture for ${key}`);
    if (opts.fail?.includes(f.name) || opts.fail?.includes(u.host)) {
      throw new Error(`${f.name} unreachable`);
    }
    if (opts.override && f.name in opts.override) return JSON.stringify(opts.override[f.name]);
    return JSON.stringify(loadFixture(f.name));
  };
  const http: HttpClient = {
    text,
    async json<T>(url: string) {
      return JSON.parse(await text(url)) as T;
    },
    async bytes() {
      throw new Error("no binary fixtures");
    },
  };
  return { http, requests };
}
