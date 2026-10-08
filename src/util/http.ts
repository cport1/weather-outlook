import type { CacheLookup, DiskCache } from "../cache/disk-cache.ts";

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
  /**
   * Use the server's `Expires` header as the TTL when present (MET Norway's
   * terms require not re-requesting before it). `ttlMs` is the fallback.
   */
  honorExpires?: boolean;
  /**
   * Serve a stale entry immediately and revalidate in the background.
   * Overrides the client-wide default.
   */
  swr?: boolean;
}

export interface HttpClient {
  text(url: string, opts: FetchOptions): Promise<string>;
  /** Binary body (e.g. PNG tiles). Cached as base64. */
  bytes(url: string, opts: FetchOptions): Promise<Uint8Array>;
  json<T = unknown>(url: string, opts: FetchOptions): Promise<T>;
  /** Subscribe to background revalidations that brought new data. Returns an unsubscribe. */
  onBackgroundUpdate?(listener: (url: string) => void): () => void;
  /** Resolves once every background revalidation started so far has settled. */
  settled?(): Promise<void>;
}

export interface HttpClientOptions {
  /** Default for `FetchOptions.swr`. The dashboard turns this on. */
  swr?: boolean;
  /** Don't serve entries older than this via stale-while-revalidate. Default 24h. */
  maxStaleMs?: number;
  /** Minimum spacing between requests to a host, in ms. */
  hostIntervals?: Record<string, number>;
}

/** Nominatim's usage policy: at most one request per second. */
export const DEFAULT_HOST_INTERVALS: Record<string, number> = {
  "nominatim.openstreetmap.org": 1_100,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TTL implied by an `Expires` header, measured against the server's `Date` to dodge clock skew. */
export function expiresTtl(headers: Headers, now = Date.now()): number | undefined {
  const exp = headers.get("expires");
  if (!exp) return undefined;
  const expMs = Date.parse(exp);
  if (Number.isNaN(expMs)) return undefined;
  const dateMs = Date.parse(headers.get("date") ?? "");
  return Math.max(0, expMs - (Number.isNaN(dateMs) ? now : dateMs));
}

/** Serializes requests per host so each starts at least `interval` ms after the previous one. */
export function createRateLimiter(
  intervals: Record<string, number>,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<unknown> = sleep,
) {
  const nextAt = new Map<string, number>();
  return async function slot(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const interval = intervals[host];
    if (!interval) return;
    const t = now();
    const at = Math.max(t, nextAt.get(host) ?? 0);
    nextAt.set(host, at + interval);
    if (at > t) await wait(at - t);
  };
}

interface NetResult {
  status: number;
  body: string;
  etag?: string;
  lastModified?: string;
  ttlMs?: number;
}

export function createHttpClient(
  cache: DiskCache | undefined,
  fetchImpl: typeof fetch = fetch,
  clientOpts: HttpClientOptions = {},
): HttpClient {
  const inflight = new Map<string, Promise<string>>();
  const background = new Set<Promise<unknown>>();
  const listeners = new Set<(url: string) => void>();
  const slot = createRateLimiter({ ...DEFAULT_HOST_INTERVALS, ...clientOpts.hostIntervals });
  const maxStaleMs = clientOpts.maxStaleMs ?? 24 * 3600_000;

  async function fetchWithRetry(
    url: string,
    opts: FetchOptions,
    cached: CacheLookup | undefined,
    binary: boolean,
  ): Promise<NetResult> {
    const retries = opts.retries ?? 2;
    const etag = cached?.entry.etag;
    const lastModified = cached?.entry.lastModified;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await slot(url);
        const res = await fetchImpl(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, application/geo+json, text/plain, */*",
            ...(etag ? { "If-None-Match": etag } : {}),
            ...(lastModified ? { "If-Modified-Since": lastModified } : {}),
            ...opts.headers,
          },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        const ttlMs = opts.honorExpires ? expiresTtl(res.headers) : undefined;
        if (res.status === 304) return { status: 304, body: "", ttlMs };
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
          lastModified: res.headers.get("last-modified") ?? undefined,
          ttlMs,
        };
      } catch (err) {
        lastErr = err;
        if ((err as { fatal?: boolean }).fatal) break;
        if (attempt < retries) await sleep(250 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  /** Hit the network and update the cache. Cache write failures never fail the request. */
  async function revalidate(
    url: string,
    cacheKey: string,
    opts: FetchOptions,
    cached: CacheLookup | undefined,
    binary: boolean,
  ): Promise<{ body: string; changed: boolean }> {
    const res = await fetchWithRetry(url, opts, cached, binary);
    if (res.status === 304 && cached) {
      await cache?.touch(cacheKey, cached.entry, res.ttlMs ?? opts.ttlMs).catch(() => {});
      return { body: cached.entry.body, changed: false };
    }
    await cache
      ?.set(cacheKey, res.body, res.ttlMs ?? opts.ttlMs, {
        etag: res.etag,
        lastModified: res.lastModified,
      })
      .catch(() => {});
    return { body: res.body, changed: res.body !== cached?.entry.body };
  }

  async function load(url: string, opts: FetchOptions, binary: boolean): Promise<string> {
    const cacheKey = binary ? `b:${url}` : url;
    const cached = cache && !opts.refresh ? await cache.get(cacheKey) : undefined;
    if (cached?.fresh) return cached.entry.body;
    const swr = opts.swr ?? clientOpts.swr ?? false;
    if (swr && cached && cached.ageMs < cached.entry.ttlMs + maxStaleMs) {
      // Stale-while-revalidate: answer now, refresh the cache behind the caller's back.
      const job: Promise<void> = revalidate(url, cacheKey, opts, cached, binary)
        .then(({ changed }) => {
          if (changed) for (const fn of listeners) fn(url);
        })
        .catch(() => {})
        .finally(() => background.delete(job));
      background.add(job);
      return cached.entry.body;
    }
    try {
      return (await revalidate(url, cacheKey, opts, cached, binary)).body;
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
    onBackgroundUpdate(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async settled() {
      while (background.size) await Promise.allSettled([...background]);
    },
  };
}
