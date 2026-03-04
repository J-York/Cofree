export interface SummaryCacheEntry {
  value: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface SummaryCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

const DEFAULT_OPTIONS: SummaryCacheOptions = {
  ttlMs: 10 * 60 * 1000,
  maxEntries: 100,
};

export class SummaryCache {
  private readonly entries = new Map<string, SummaryCacheEntry>();
  private readonly options: SummaryCacheOptions;

  constructor(options?: Partial<SummaryCacheOptions>) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...(options ?? {}),
    };
  }

  get(key: string, nowMs = Date.now()): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    // Refresh recency (LRU-ish)
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, nowMs = Date.now()): void {
    if (!key) return;

    const ttlMs = Math.max(1, this.options.ttlMs);
    const entry: SummaryCacheEntry = {
      value,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, entry);

    // Evict expired first
    for (const [k, v] of this.entries) {
      if (v.expiresAtMs <= nowMs) {
        this.entries.delete(k);
      }
    }

    // Evict oldest if over max
    const maxEntries = Math.max(1, this.options.maxEntries);
    while (this.entries.size > maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}
