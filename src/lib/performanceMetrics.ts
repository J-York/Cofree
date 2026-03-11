/**
 * Cofree - AI Programming Cafe
 * File: src/lib/performanceMetrics.ts
 * Description: Performance metrics tracking and reporting.
 */

export interface ToolExecutionMetric {
  toolName: string;
  count: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  cached: number;
  cacheHitRate: number;
}

export interface PerformanceMetrics {
  // Overall statistics
  sessionStartTime: number;
  sessionDuration: number;

  // Tool call statistics
  totalToolCalls: number;
  cachedToolCalls: number;
  cacheHitRate: number;
  uniqueTools: number;

  // Concurrency statistics
  maxConcurrentReads: number;
  avgConcurrentReads: number;
  totalParallelBatches: number;

  // Time statistics
  totalExecutionTime: number;
  toolExecutionTime: Record<string, number>;
  avgToolLatency: Record<string, number>;

  // Per-tool details
  toolMetrics: Record<string, ToolExecutionMetric>;

  // Cache statistics
  cacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  cacheInvalidations: number;

  // Model call statistics
  totalModelCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgModelLatency: number;
}

/**
 * Performance metrics tracker.
 */
export class PerformanceMetricsTracker {
  private sessionStartTime: number;
  private toolExecutions: Array<{
    toolName: string;
    startTime: number;
    endTime: number;
    cached: boolean;
  }> = [];
  private concurrentReadSamples: number[] = [];
  private parallelBatchCount = 0;
  private modelCalls: Array<{
    startTime: number;
    endTime: number;
    promptTokens: number;
    completionTokens: number;
  }> = [];

  constructor() {
    this.sessionStartTime = Date.now();
  }

  /**
   * Record a tool execution.
   */
  recordToolExecution(
    toolName: string,
    executionTimeMs: number,
    cached: boolean
  ): void {
    this.toolExecutions.push({
      toolName,
      startTime: Date.now() - executionTimeMs,
      endTime: Date.now(),
      cached,
    });
  }

  /**
   * Record concurrent read count sample.
   */
  recordConcurrentReads(count: number): void {
    this.concurrentReadSamples.push(count);
  }

  /**
   * Increment parallel batch counter.
   */
  incrementParallelBatch(): void {
    this.parallelBatchCount++;
  }

  /**
   * Record a model API call.
   */
  recordModelCall(
    latencyMs: number,
    promptTokens: number,
    completionTokens: number
  ): void {
    this.modelCalls.push({
      startTime: Date.now() - latencyMs,
      endTime: Date.now(),
      promptTokens,
      completionTokens,
    });
  }

  /**
   * Compute performance metrics.
   */
  computeMetrics(cacheStats?: {
    hits: number;
    misses: number;
    size: number;
    evictions: number;
    invalidations: number;
  }): PerformanceMetrics {
    const now = Date.now();
    const sessionDuration = now - this.sessionStartTime;

    // Tool statistics
    const toolMetricsMap = new Map<string, ToolExecutionMetric>();
    let totalExecutionTime = 0;
    let cachedCount = 0;

    for (const exec of this.toolExecutions) {
      const duration = exec.endTime - exec.startTime;
      totalExecutionTime += duration;

      if (exec.cached) {
        cachedCount++;
      }

      let metric = toolMetricsMap.get(exec.toolName);
      if (!metric) {
        metric = {
          toolName: exec.toolName,
          count: 0,
          totalTime: 0,
          avgTime: 0,
          minTime: Infinity,
          maxTime: 0,
          cached: 0,
          cacheHitRate: 0,
        };
        toolMetricsMap.set(exec.toolName, metric);
      }

      metric.count++;
      metric.totalTime += duration;
      metric.minTime = Math.min(metric.minTime, duration);
      metric.maxTime = Math.max(metric.maxTime, duration);
      if (exec.cached) {
        metric.cached++;
      }
    }

    // Compute averages
    const toolMetrics: Record<string, ToolExecutionMetric> = {};
    const toolExecutionTime: Record<string, number> = {};
    const avgToolLatency: Record<string, number> = {};

    for (const [toolName, metric] of toolMetricsMap) {
      metric.avgTime = metric.count > 0 ? metric.totalTime / metric.count : 0;
      metric.cacheHitRate = metric.count > 0 ? metric.cached / metric.count : 0;
      toolMetrics[toolName] = metric;
      toolExecutionTime[toolName] = metric.totalTime;
      avgToolLatency[toolName] = metric.avgTime;
    }

    // Concurrency statistics
    const maxConcurrentReads =
      this.concurrentReadSamples.length > 0
        ? Math.max(...this.concurrentReadSamples)
        : 0;
    const avgConcurrentReads =
      this.concurrentReadSamples.length > 0
        ? this.concurrentReadSamples.reduce((a, b) => a + b, 0) /
          this.concurrentReadSamples.length
        : 0;

    // Model call statistics
    const totalModelCalls = this.modelCalls.length;
    const totalPromptTokens = this.modelCalls.reduce(
      (sum, call) => sum + call.promptTokens,
      0
    );
    const totalCompletionTokens = this.modelCalls.reduce(
      (sum, call) => sum + call.completionTokens,
      0
    );
    const avgModelLatency =
      this.modelCalls.length > 0
        ? this.modelCalls.reduce(
            (sum, call) => sum + (call.endTime - call.startTime),
            0
          ) / this.modelCalls.length
        : 0;

    // Cache statistics
    const cacheHits = cacheStats?.hits ?? 0;
    const cacheMisses = cacheStats?.misses ?? 0;
    // const totalCacheAccess = cacheHits + cacheMisses;

    return {
      sessionStartTime: this.sessionStartTime,
      sessionDuration,
      totalToolCalls: this.toolExecutions.length,
      cachedToolCalls: cachedCount,
      cacheHitRate: this.toolExecutions.length > 0 ? cachedCount / this.toolExecutions.length : 0,
      uniqueTools: toolMetricsMap.size,
      maxConcurrentReads,
      avgConcurrentReads,
      totalParallelBatches: this.parallelBatchCount,
      totalExecutionTime,
      toolExecutionTime,
      avgToolLatency,
      toolMetrics,
      cacheSize: cacheStats?.size ?? 0,
      cacheHits,
      cacheMisses,
      cacheEvictions: cacheStats?.evictions ?? 0,
      cacheInvalidations: cacheStats?.invalidations ?? 0,
      totalModelCalls,
      totalPromptTokens,
      totalCompletionTokens,
      avgModelLatency,
    };
  }

  /**
   * Generate a performance report summary.
   */
  generateReport(metrics: PerformanceMetrics): string {
    const lines: string[] = [];
    lines.push("=== Performance Report ===");
    lines.push(`Session Duration: ${(metrics.sessionDuration / 1000).toFixed(1)}s`);
    lines.push("");

    lines.push("Tool Call Statistics:");
    lines.push(`  Total Tool Calls: ${metrics.totalToolCalls}`);
    lines.push(`  Cached Tool Calls: ${metrics.cachedToolCalls}`);
    lines.push(`  Cache Hit Rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%`);
    lines.push(`  Unique Tools: ${metrics.uniqueTools}`);
    lines.push("");

    lines.push("Concurrency:");
    lines.push(`  Max Concurrent Reads: ${metrics.maxConcurrentReads}`);
    lines.push(`  Avg Concurrent Reads: ${metrics.avgConcurrentReads.toFixed(1)}`);
    lines.push(`  Parallel Batches: ${metrics.totalParallelBatches}`);
    lines.push("");

    lines.push("Cache Statistics:");
    lines.push(`  Cache Size: ${metrics.cacheSize} entries`);
    lines.push(`  Cache Hits: ${metrics.cacheHits}`);
    lines.push(`  Cache Misses: ${metrics.cacheMisses}`);
    lines.push(
      `  Cache Hit Rate: ${(metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses || 1) * 100).toFixed(1)}%`
    );
    lines.push(`  Evictions: ${metrics.cacheEvictions}`);
    lines.push(`  Invalidations: ${metrics.cacheInvalidations}`);
    lines.push("");

    lines.push("Model Calls:");
    lines.push(`  Total Calls: ${metrics.totalModelCalls}`);
    lines.push(`  Prompt Tokens: ${metrics.totalPromptTokens.toLocaleString()}`);
    lines.push(`  Completion Tokens: ${metrics.totalCompletionTokens.toLocaleString()}`);
    lines.push(`  Avg Latency: ${metrics.avgModelLatency.toFixed(0)}ms`);
    lines.push("");

    lines.push("Top Tools by Call Count:");
    const sortedByCount = Object.values(metrics.toolMetrics).sort(
      (a, b) => b.count - a.count
    );
    for (const metric of sortedByCount.slice(0, 10)) {
      lines.push(
        `  ${metric.toolName}: ${metric.count} calls, ${metric.avgTime.toFixed(0)}ms avg, ${(metric.cacheHitRate * 100).toFixed(0)}% cached`
      );
    }

    return lines.join("\n");
  }

  /**
   * Reset all tracking data.
   */
  reset(): void {
    this.sessionStartTime = Date.now();
    this.toolExecutions = [];
    this.concurrentReadSamples = [];
    this.parallelBatchCount = 0;
    this.modelCalls = [];
  }
}

/**
 * Global performance metrics tracker instance.
 */
export const globalMetricsTracker = new PerformanceMetricsTracker();
