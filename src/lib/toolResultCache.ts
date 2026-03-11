/**
 * Cofree - AI Programming Cafe
 * File: src/lib/toolResultCache.ts
 * Description: Tool result caching system to reduce redundant tool calls.
 *
 * Design Goals:
 * - Reduce repetitive tool calls by 50-70%
 * - Achieve 60%+ cache hit rate
 * - Smart invalidation based on file system events
 */

export interface ToolResultCacheEntry {
  result: string;
  timestamp: number;
  expiresAt: number;
  dependencies?: string[]; // File paths this result depends on
  metadata?: Record<string, unknown>;
}

export interface CachePolicy {
  ttlMs: number;
  invalidateOn?: InvalidationEvent[];
  maxSize?: number;
}

export type InvalidationEvent = "file_change" | "git_operation" | "workspace_change";

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  evictions: number;
  size: number;
}

/**
 * Tool result cache with TTL and event-based invalidation.
 *
 * Caching Strategy:
 * - read_file: 30s TTL, invalidate on file_change
 * - list_files: 60s TTL, invalidate on workspace_change
 * - git_status: 5s TTL, invalidate on git_operation
 * - git_diff: 5s TTL, invalidate on git_operation
 * - diagnostics: 120s TTL, invalidate on file_change
 * - grep: 60s TTL, invalidate on file_change
 * - glob: 60s TTL, invalidate on workspace_change
 */
export class ToolResultCache {
  private cache = new Map<string, ToolResultCacheEntry>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    invalidations: 0,
    evictions: 0,
    size: 0,
  };

  // Cache policies per tool
  private readonly policies: Record<string, CachePolicy> = {
    read_file: { ttlMs: 30000, invalidateOn: ["file_change"], maxSize: 200 },
    list_files: { ttlMs: 60000, invalidateOn: ["workspace_change"], maxSize: 50 },
    git_status: { ttlMs: 5000, invalidateOn: ["git_operation"], maxSize: 10 },
    git_diff: { ttlMs: 5000, invalidateOn: ["git_operation"], maxSize: 10 },
    diagnostics: { ttlMs: 120000, invalidateOn: ["file_change"], maxSize: 5 },
    grep: { ttlMs: 60000, invalidateOn: ["file_change"], maxSize: 100 },
    glob: { ttlMs: 60000, invalidateOn: ["workspace_change"], maxSize: 100 },
  };

  private readonly maxTotalEntries = 1000;

  constructor(customPolicies?: Partial<Record<string, CachePolicy>>) {
    if (customPolicies) {
      Object.assign(this.policies, customPolicies);
    }
  }

  /**
   * Generate a stable cache key from tool name and arguments.
   */
  generateKey(toolName: string, args: Record<string, unknown>): string {
    // Sort keys for stable serialization
    const sortedArgs = Object.keys(args)
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as Record<string, unknown>);

    return `${toolName}:${JSON.stringify(sortedArgs)}`;
  }

  /**
   * Get cached result if available and not expired.
   */
  get(toolName: string, args: Record<string, unknown>): string | null {
    const key = this.generateKey(toolName, args);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const now = Date.now();
    if (now >= entry.expiresAt) {
      // Expired entry
      this.cache.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return null;
    }

    this.stats.hits++;
    return entry.result;
  }

  /**
   * Store a tool result in the cache.
   */
  set(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    dependencies?: string[]
  ): void {
    const policy = this.policies[toolName];
    if (!policy) {
      // No caching policy for this tool
      return;
    }

    const key = this.generateKey(toolName, args);
    const now = Date.now();

    const entry: ToolResultCacheEntry = {
      result,
      timestamp: now,
      expiresAt: now + policy.ttlMs,
      dependencies,
      metadata: { toolName },
    };

    this.cache.set(key, entry);
    this.stats.sets++;
    this.stats.size = this.cache.size;

    // LRU eviction if needed
    this.evictIfNeeded();
  }

  /**
   * Invalidate cache entries based on events.
   */
  invalidate(event: InvalidationEvent, affectedPaths?: string[]): void {
    let invalidatedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      const toolName = entry.metadata?.toolName as string | undefined;
      if (!toolName) continue;

      const policy = this.policies[toolName];
      if (!policy || !policy.invalidateOn) continue;

      if (!policy.invalidateOn.includes(event)) continue;

      // Check if this entry should be invalidated
      let shouldInvalidate = !affectedPaths || affectedPaths.length === 0;

      if (!shouldInvalidate && affectedPaths && entry.dependencies) {
        // Check if any affected path matches dependencies
        shouldInvalidate = entry.dependencies.some((dep) =>
          affectedPaths.some((path) => this.pathsMatch(dep, path))
        );
      }

      if (shouldInvalidate) {
        this.cache.delete(key);
        invalidatedCount++;
      }
    }

    this.stats.invalidations += invalidatedCount;
    this.stats.size = this.cache.size;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.evictions += size;
    this.stats.size = 0;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get cache hit rate.
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      evictions: 0,
      size: this.cache.size,
    };
  }

  /**
   * Evict old entries if cache is too large.
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxTotalEntries) {
      return;
    }

    // Evict oldest entries (LRU)
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = this.cache.size - this.maxTotalEntries;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.cache.delete(entries[i][0]);
      this.stats.evictions++;
    }

    this.stats.size = this.cache.size;
  }

  /**
   * Check if two paths match (simple equality or prefix match).
   */
  private pathsMatch(path1: string, path2: string): boolean {
    const normalized1 = path1.replace(/\\/g, "/");
    const normalized2 = path2.replace(/\\/g, "/");

    return (
      normalized1 === normalized2 ||
      normalized1.startsWith(normalized2 + "/") ||
      normalized2.startsWith(normalized1 + "/")
    );
  }
}

/**
 * Global tool result cache instance.
 */
export const globalToolCache = new ToolResultCache();

/**
 * Helper to extract file dependencies from tool arguments.
 */
export function extractFileDependencies(
  toolName: string,
  args: Record<string, unknown>
): string[] | undefined {
  switch (toolName) {
    case "read_file":
      return args.path ? [args.path as string] : undefined;
    case "list_files":
      return args.path ? [args.path as string] : undefined;
    case "grep":
    case "glob":
      return args.path ? [args.path as string] : undefined;
    case "git_status":
    case "git_diff":
      // Git operations depend on entire workspace
      return undefined;
    case "diagnostics":
      // Diagnostics depend on entire workspace
      return undefined;
    default:
      return undefined;
  }
}
