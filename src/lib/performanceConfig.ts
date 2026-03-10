/**
 * Cofree - AI Programming Cafe
 * File: src/lib/performanceConfig.ts
 * Description: Performance configuration for concurrency and caching.
 */

export interface PerformanceConfig {
  // Concurrency limits
  maxParallelReadTools: number;
  maxParallelSubAgents: number;
  maxParallelSummaryChunks: number;

  // Cache settings
  enableToolCache: boolean;
  toolCacheTTL: Record<string, number>;
  maxCacheSize: number;

  // Monitoring
  enablePerformanceMetrics: boolean;
  metricsReportingInterval: number;
}

/**
 * Default performance configuration.
 *
 * Optimizations from v0.0.8:
 * - Increased read tool parallelism from 5 to 15 (3x improvement)
 * - Increased sub-agent parallelism from 3 to 5 (67% improvement)
 * - Increased summary chunk parallelism from 3 to 5 (67% improvement)
 * - Enabled tool result caching
 */
export const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = {
  // Concurrency (optimized for modern multi-core CPUs)
  maxParallelReadTools: 15,
  maxParallelSubAgents: 5,
  maxParallelSummaryChunks: 5,

  // Cache settings
  enableToolCache: true,
  toolCacheTTL: {
    read_file: 30000, // 30s
    list_files: 60000, // 60s
    git_status: 5000, // 5s
    git_diff: 5000, // 5s
    diagnostics: 120000, // 120s (2min)
    grep: 60000, // 60s
    glob: 60000, // 60s
  },
  maxCacheSize: 1000,

  // Monitoring
  enablePerformanceMetrics: true,
  metricsReportingInterval: 60000, // 60s
};

/**
 * Conservative performance configuration for resource-constrained environments.
 */
export const CONSERVATIVE_PERFORMANCE_CONFIG: PerformanceConfig = {
  maxParallelReadTools: 8,
  maxParallelSubAgents: 3,
  maxParallelSummaryChunks: 3,
  enableToolCache: true,
  toolCacheTTL: DEFAULT_PERFORMANCE_CONFIG.toolCacheTTL,
  maxCacheSize: 500,
  enablePerformanceMetrics: true,
  metricsReportingInterval: 120000,
};

/**
 * Aggressive performance configuration for powerful machines.
 */
export const AGGRESSIVE_PERFORMANCE_CONFIG: PerformanceConfig = {
  maxParallelReadTools: 25,
  maxParallelSubAgents: 8,
  maxParallelSummaryChunks: 8,
  enableToolCache: true,
  toolCacheTTL: DEFAULT_PERFORMANCE_CONFIG.toolCacheTTL,
  maxCacheSize: 2000,
  enablePerformanceMetrics: true,
  metricsReportingInterval: 30000,
};

/**
 * Get performance configuration from settings or use default.
 */
export function getPerformanceConfig(
  profile: "default" | "conservative" | "aggressive" = "default"
): PerformanceConfig {
  switch (profile) {
    case "conservative":
      return { ...CONSERVATIVE_PERFORMANCE_CONFIG };
    case "aggressive":
      return { ...AGGRESSIVE_PERFORMANCE_CONFIG };
    default:
      return { ...DEFAULT_PERFORMANCE_CONFIG };
  }
}

/**
 * Validate performance configuration.
 */
export function validatePerformanceConfig(config: PerformanceConfig): boolean {
  if (config.maxParallelReadTools < 1 || config.maxParallelReadTools > 50) {
    return false;
  }
  if (config.maxParallelSubAgents < 1 || config.maxParallelSubAgents > 20) {
    return false;
  }
  if (config.maxParallelSummaryChunks < 1 || config.maxParallelSummaryChunks > 20) {
    return false;
  }
  if (config.maxCacheSize < 10 || config.maxCacheSize > 10000) {
    return false;
  }
  return true;
}
