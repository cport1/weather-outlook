import type { DiskCache } from "../cache/disk-cache.ts";

export const USER_AGENT = "weather-outlook/2.0 (+https://github.com/cport1/weather-outlook)";

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
          body: await res.text(),
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

  async function load(url: string, opts: FetchOptions): Promise<string> {
    const cached = cache && !opts.refresh ? await cache.get(url) : undefined;
    if (cached?.fresh) return cached.entry.body;
    try {
      const res = await fetchWithRetry(url, opts, cached?.entry.etag);
      if (res.status === 304 && cached) {
        await cache?.touch(url, cached.entry);
        return cached.entry.body;
      }
      await cache?.set(url, res.body, opts.ttlMs, res.etag);
      return res.body;
    } catch (err) {
      if (cached && opts.staleIfError !== false) return cached.entry.body;
      throw err;
    }
  }

  function text(url: string, opts: FetchOptions): Promise<string> {
    const existing = inflight.get(url);
    if (existing) return existing;
    const p = load(url, opts).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }

  return {
    text,
    async json<T>(url: string, opts: FetchOptions): Promise<T> {
      return JSON.parse(await text(url, opts)) as T;
    },
  };
}
