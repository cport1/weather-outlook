import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Tiny on-disk TTL cache with stale-while-revalidate semantics.
 * Entries are keyed by a sha256 of the request key and stored as JSON.
 * File mtimes double as LRU timestamps: hits touch the file, and pruning
 * deletes the least recently used entries once the directory exceeds its cap.
 */

export interface CacheEntry {
  key: string;
  fetchedAt: number;
  ttlMs: number;
  etag?: string;
  /** Server's Last-Modified, replayed as If-Modified-Since. */
  lastModified?: string;
  body: string;
}

export interface CacheLookup {
  entry: CacheEntry;
  fresh: boolean;
  /** Time since the entry was fetched, on the cache's clock. */
  ageMs: number;
}

export interface CacheMeta {
  etag?: string;
  lastModified?: string;
}

export interface DiskCacheOptions {
  /** Prune least-recently-used entries when the cache grows past this. Default 256 MB. */
  maxBytes?: number;
}

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 5 * 60_000;

export class DiskCache {
  readonly maxBytes: number;
  private lastPrune = 0;

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
    opts: DiskCacheOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private pathFor(key: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
    return join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }

  async get(key: string): Promise<CacheLookup | undefined> {
    const file = this.pathFor(key);
    try {
      const raw = await readFile(file, "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.key !== key) return undefined;
      // Mark as recently used for LRU pruning; failure here is harmless.
      const t = new Date();
      utimes(file, t, t).catch(() => {});
      const ageMs = this.now() - entry.fetchedAt;
      return { entry, fresh: ageMs < entry.ttlMs, ageMs };
    } catch {
      return undefined;
    }
  }

  async set(key: string, body: string, ttlMs: number, meta: CacheMeta = {}): Promise<CacheEntry> {
    const entry: CacheEntry = { key, fetchedAt: this.now(), ttlMs, ...meta, body };
    const file = this.pathFor(key);
    await mkdir(join(file, ".."), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written entry behind.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, file);
    this.maybePrune();
    return entry;
  }

  /** Re-stamp an entry after a 304, optionally with a new TTL from the server. */
  async touch(key: string, entry: CacheEntry, ttlMs = entry.ttlMs): Promise<CacheEntry> {
    return this.set(key, entry.body, ttlMs, { etag: entry.etag, lastModified: entry.lastModified });
  }

  private maybePrune(): void {
    const t = Date.now();
    if (t - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = t;
    this.prune().catch(() => {});
  }

  private async files(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    let names: string[];
    try {
      names = await readdir(this.dir, { recursive: true });
    } catch {
      return [];
    }
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      try {
        const s = await stat(path);
        if (s.isFile()) out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // Raced with another process deleting it.
      }
    }
    return out;
  }

  /** Total bytes and entry count on disk. */
  async size(): Promise<{ bytes: number; entries: number }> {
    const files = await this.files();
    return { bytes: files.reduce((a, f) => a + f.size, 0), entries: files.length };
  }

  /**
   * Delete least-recently-used entries until the cache is under 80% of
   * `maxBytes` (the headroom avoids pruning again on the very next write).
   * Returns the number of files removed.
   */
  async prune(maxBytes = this.maxBytes): Promise<number> {
    const files = await this.files();
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total <= maxBytes) return 0;
    const target = maxBytes * 0.8;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const f of files) {
      if (total <= target) break;
      try {
        await unlink(f.path);
        total -= f.size;
        removed++;
      } catch {
        // Already gone.
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
