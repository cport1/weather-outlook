import type { DiskCache } from "../cache/disk-cache.ts";

/**
 * NOAA's firewall 403s any User-Agent containing the substring "outlook"
 * (even inside a URL), and MET Norway/Nominatim require a real contact.
 * So the UA deliberately names the project "wxo" and links the owner profile.
 */
export const USER_AGENT = "wxo/2.0 (+https://github.com/cport1; weather CLI)";

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchOptions {
  /** How long a response is considered fresh. */
  ttlMs: number;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Serve a stale cache entry if the network fails. Defaults to true. */
  staleIfError?: boolean;
  /** Skip the cache read (still writes). */
  refresh?: boolean;
}

export interface HttpClient {
  text(url: string, opts: FetchOptions): Promise<string>;
  /** Binary body (e.g. PNG tiles). Cached as base64. */
  bytes(url: string, opts: FetchOptions): Promise<Uint8Array>;
  json<T = unknown>(url: string, opts: FetchOptions): Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHttpClient(
  cache: DiskCache | undefined,
  fetchImpl: typeof fetch = fetch,
): HttpClient {
  const inflight = new Map<string, Promise<string>>();

  async function fetchWithRetry(
    url: string,
    opts: FetchOptions,
    etag: string | undefined,
    binary: boolean,
  ): Promise<{ status: number; body: string; etag?: string }> {
    const retries = opts.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, application/geo+json, text/plain, */*",
            ...(etag ? { "If-None-Match": etag } : {}),
            ...opts.headers,
          },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        if (res.status === 304) return { status: 304, body: "" };
        if (res.status >= 500 || res.status === 429) {
          throw new HttpError(url, res.status, `${res.status} ${res.statusText}`);
        }
        if (!res.ok) {
          // 4xx other than 429 will not get better by retrying.
          throw Object.assign(new HttpError(url, res.status, `${res.status} ${res.statusText}`), {
            fatal: true,
          });
        }
        return {
          status: res.status,
          body: binary ? Buffer.from(await res.arrayBuffer()).toString("base64") : await res.text(),
          etag: res.headers.get("etag") ?? undefined,
        };
      } catch (err) {
        lastErr = err;
        if ((err as { fatal?: boolean }).fatal) break;
        if (attempt < retries) await sleep(250 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  async function load(url: string, opts: FetchOptions, binary: boolean): Promise<string> {
    const cacheKey = binary ? `b:${url}` : url;
    const cached = cache && !opts.refresh ? await cache.get(cacheKey) : undefined;
    if (cached?.fresh) return cached.entry.body;
    try {
      const res = await fetchWithRetry(url, opts, cached?.entry.etag, binary);
      if (res.status === 304 && cached) {
        await cache?.touch(cacheKey, cached.entry);
        return cached.entry.body;
      }
      await cache?.set(cacheKey, res.body, opts.ttlMs, res.etag);
      return res.body;
    } catch (err) {
      if (cached && opts.staleIfError !== false) return cached.entry.body;
      throw err;
    }
  }

  function dedupe(url: string, opts: FetchOptions, binary: boolean): Promise<string> {
    const key = `${binary ? "b:" : ""}${url}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = load(url, opts, binary).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const text = (url: string, opts: FetchOptions) => dedupe(url, opts, false);

  return {
    text,
    async bytes(url, opts) {
      return new Uint8Array(Buffer.from(await dedupe(url, opts, true), "base64"));
    },
    async json<T>(url: string, opts: FetchOptions): Promise<T> {
      return JSON.parse(await text(url, opts)) as T;
    },
  };
}
