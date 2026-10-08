import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tiny on-disk TTL cache with stale-while-revalidate semantics.
 * Entries are keyed by a sha256 of the request key and stored as JSON.
 */

export interface CacheEntry {
  key: string;
  fetchedAt: number;
  ttlMs: number;
  etag?: string;
  body: string;
}

export interface CacheLookup {
  entry: CacheEntry;
  fresh: boolean;
}

export class DiskCache {
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private pathFor(key: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
    return join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }

  async get(key: string): Promise<CacheLookup | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.key !== key) return undefined;
      return { entry, fresh: this.now() - entry.fetchedAt < entry.ttlMs };
    } catch {
      return undefined;
    }
  }

  async set(key: string, body: string, ttlMs: number, etag?: string): Promise<CacheEntry> {
    const entry: CacheEntry = { key, fetchedAt: this.now(), ttlMs, etag, body };
    const file = this.pathFor(key);
    await mkdir(join(file, ".."), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written entry behind.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, file);
    return entry;
  }

  async touch(key: string, entry: CacheEntry): Promise<CacheEntry> {
    return this.set(key, entry.body, entry.ttlMs, entry.etag);
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
