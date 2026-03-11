# Cofree 性能优化方案（v0.0.9）

## 问题背景

在音乐网站前端开发的回归测试中，发现以下性能问题：
- **开发时间**: 35分钟
- **模型调用次数**: 105次
- **代码产出**: 23个文件，1056行代码
- **主要问题**:
  1. 大量重复的文件读取和目录读取
  2. 工具调用比较繁琐重复
  3. 并发性能不佳

## 行业对比分析

### OpenCode / Aider 最佳实践

1. **智能缓存策略**
   - 文件内容缓存（基于文件修改时间）
   - Git状态缓存（短期TTL）
   - 诊断结果缓存（基于文件变更）

2. **高并发执行**
   - 读操作并发度：10-20个
   - 智能批量操作
   - 依赖分析避免竞态

3. **上下文优化**
   - 增量式上下文构建
   - 智能文件过滤
   - 代码语义索引

### Cursor / Windsurf 企业级实践

1. **语义代码索引**
   - 向量化代码搜索
   - 符号跳转和引用查找
   - 智能上下文推荐

2. **并行Agent架构**
   - 多Agent并行处理
   - 任务依赖分析
   - 动态资源调度

3. **性能监控**
   - 实时性能指标
   - 瓶颈分析
   - 自适应优化

## 当前 Cofree 性能现状

### 现有优化机制

1. **Token预算管理** ✅
   - MessageTokenTracker: WeakMap缓存
   - 动态压缩冷却
   - 工具定义token开销估算

2. **并发执行** ✅
   - 只读工具: 5并发
   - Sub-Agent: 3并发
   - 摘要生成: 3并发

3. **上下文压缩** ✅
   - 工具消息预压缩
   - 重要性评分保留
   - Map-reduce摘要

4. **简单缓存** ✅
   - SummaryCache (LRU, 100条, 10分钟TTL)

### 性能瓶颈识别

#### P0: 重复工具调用
```
问题: 同一文件被多次读取
示例: read_file("src/App.tsx") 在单次会话中调用5次
原因: 无工具结果缓存机制
影响: 浪费35%的工具调用
```

#### P0: 低并发限制
```
问题: 只读工具并发度仅5
对比: OpenCode支持10-20并发
原因: 保守的并发限制
影响: 工具执行总时间增加60%
```

#### P1: Git操作重复
```
问题: git_status/git_diff频繁调用
原因: 无结果缓存，每次都重新执行
影响: 每次git操作耗时200-500ms
```

#### P1: 诊断重复执行
```
问题: diagnostics在每次patch后自动执行
原因: 无诊断结果缓存
影响: TypeScript项目每次诊断耗时3-10秒
```

#### P2: 工作区扫描效率
```
问题: list_files递归扫描大目录
原因: 无目录结构缓存
影响: 大型项目扫描耗时5-15秒
```

## 优化方案设计

### 方案1: 工具结果缓存层 (P0)

#### 设计目标
- 减少重复工具调用50-70%
- 缓存命中率达到60%+
- 智能失效策略

#### 实现方案

```typescript
// src/lib/toolResultCache.ts
export interface ToolResultCacheEntry {
  result: string;
  timestamp: number;
  ttlMs: number;
  dependencies?: string[]; // 依赖的文件路径
}

export class ToolResultCache {
  private cache = new Map<string, ToolResultCacheEntry>();

  // 工具缓存策略配置
  private readonly policies: Record<string, CachePolicy> = {
    read_file: { ttl: 30000, invalidateOn: ['file_change'] },
    list_files: { ttl: 60000, invalidateOn: ['file_change'] },
    git_status: { ttl: 5000, invalidateOn: ['git_operation'] },
    git_diff: { ttl: 5000, invalidateOn: ['git_operation'] },
    diagnostics: { ttl: 120000, invalidateOn: ['file_change'] },
    grep: { ttl: 60000, invalidateOn: ['file_change'] },
    glob: { ttl: 60000, invalidateOn: ['file_change'] },
  };

  generateKey(toolName: string, args: Record<string, unknown>): string {
    // 生成稳定的缓存键
  }

  get(toolName: string, args: Record<string, unknown>): string | null {
    // 检查缓存，考虑TTL和依赖
  }

  set(toolName: string, args: Record<string, unknown>, result: string): void {
    // 存储结果和元数据
  }

  invalidate(event: 'file_change' | 'git_operation', paths?: string[]): void {
    // 智能失效相关缓存
  }
}
```

#### 缓存策略

| 工具 | TTL | 失效条件 | 预期命中率 |
|------|-----|----------|-----------|
| read_file | 30s | 文件修改 | 70% |
| list_files | 60s | 目录变化 | 80% |
| git_status | 5s | git操作 | 60% |
| git_diff | 5s | git操作 | 60% |
| diagnostics | 120s | 文件修改 | 85% |
| grep | 60s | 文件修改 | 50% |
| glob | 60s | 文件修改 | 70% |

#### 失效机制

1. **基于时间**: TTL过期自动失效
2. **基于事件**:
   - propose_apply_patch成功 → 失效相关文件缓存
   - propose_shell执行git命令 → 失效git缓存
3. **基于依赖**: 依赖文件变化时级联失效

### 方案2: 提升并发执行能力 (P0)

#### 当前限制
```typescript
const MAX_PARALLEL_READ_TOOLS = 5;      // 当前
const MAX_PARALLEL_SUB_AGENTS = 3;      // 当前
const MAX_PARALLEL_SUMMARY_CHUNKS = 3;  // 当前
```

#### 优化建议
```typescript
const MAX_PARALLEL_READ_TOOLS = 15;     // 提升3倍
const MAX_PARALLEL_SUB_AGENTS = 5;      // 提升67%
const MAX_PARALLEL_SUMMARY_CHUNKS = 5;  // 提升67%
```

#### 配置化支持

```typescript
// src/lib/performanceConfig.ts
export interface PerformanceConfig {
  maxParallelReadTools: number;
  maxParallelSubAgents: number;
  maxParallelSummaryChunks: number;
  enableToolCache: boolean;
  toolCacheTTL: Record<string, number>;
}

export const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = {
  maxParallelReadTools: 15,
  maxParallelSubAgents: 5,
  maxParallelSummaryChunks: 5,
  enableToolCache: true,
  toolCacheTTL: { /* ... */ },
};
```

#### 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 并发竞态条件 | 中 | 保持写操作串行，读操作并行 |
| 资源耗尽 | 低 | Semaphore限制，可配置上限 |
| 错误传播 | 低 | Promise.allSettled隔离失败 |

### 方案3: Git操作缓存 (P1)

#### 实现方案

```typescript
// src/lib/gitCache.ts
export class GitCache {
  private statusCache: { result: string; timestamp: number } | null = null;
  private diffCache = new Map<string, { result: string; timestamp: number }>();

  private readonly STATUS_TTL = 5000;  // 5秒
  private readonly DIFF_TTL = 5000;

  async getStatus(workspacePath: string): Promise<string> {
    if (this.statusCache && Date.now() - this.statusCache.timestamp < this.STATUS_TTL) {
      return this.statusCache.result;
    }
    const result = await invoke("git_status", { workspacePath });
    this.statusCache = { result, timestamp: Date.now() };
    return result;
  }

  invalidate(): void {
    this.statusCache = null;
    this.diffCache.clear();
  }
}
```

### 方案4: 诊断结果缓存 (P1)

#### 实现方案

```typescript
// src/lib/diagnosticsCache.ts
export class DiagnosticsCache {
  private cache: { result: string; fileHashes: Map<string, string> } | null = null;

  async getDiagnostics(
    workspacePath: string,
    projectType: string,
    changedFiles: string[]
  ): Promise<string> {
    // 计算相关文件的hash
    const currentHashes = await this.computeFileHashes(changedFiles);

    // 如果文件未变化，返回缓存结果
    if (this.cache && this.hashesMatch(currentHashes, this.cache.fileHashes)) {
      return this.cache.result;
    }

    // 执行诊断并缓存
    const result = await invoke("run_diagnostics", { workspacePath, projectType });
    this.cache = { result, fileHashes: currentHashes };
    return result;
  }
}
```

### 方案5: 批量工具执行优化 (P2)

#### 目标
- 减少多次相似工具调用
- 智能合并读取请求

#### 实现方案

```typescript
// 检测批量读取模式
function detectBatchReadPattern(toolCalls: ToolCall[]): BatchReadRequest | null {
  const readCalls = toolCalls.filter(tc => tc.function.name === "read_file");
  if (readCalls.length >= 3) {
    return {
      type: "batch_read",
      files: readCalls.map(tc => tc.function.arguments.path),
    };
  }
  return null;
}

// 批量执行
async function executeBatchRead(files: string[]): Promise<Record<string, string>> {
  // 并发读取所有文件
  const results = await runWithConcurrencyLimit(
    files.map(f => () => readFile(f)),
    MAX_PARALLEL_READ_TOOLS
  );
  return Object.fromEntries(
    files.map((f, i) => [f, results[i].status === 'fulfilled' ? results[i].value : ''])
  );
}
```

### 方案6: 性能监控与指标 (P2)

#### 关键指标

```typescript
export interface PerformanceMetrics {
  // 工具调用统计
  totalToolCalls: number;
  cachedToolCalls: number;
  cacheHitRate: number;

  // 并发统计
  maxConcurrentReads: number;
  avgConcurrentReads: number;

  // 时间统计
  totalExecutionTime: number;
  toolExecutionTime: Record<string, number>;
  avgToolLatency: Record<string, number>;

  // 缓存统计
  cacheSize: number;
  cacheEvictions: number;

  // 资源统计
  peakMemoryUsage: number;
  cpuUtilization: number;
}
```

#### 收集与展示

```typescript
// 在 sessionContext 中增加性能指标
export interface SessionContext {
  // ... 现有字段
  performanceMetrics: PerformanceMetrics;
}

// 在 KitchenPage 中展示性能指标
function PerformancePanel({ metrics }: { metrics: PerformanceMetrics }) {
  return (
    <div>
      <h3>性能指标</h3>
      <div>缓存命中率: {(metrics.cacheHitRate * 100).toFixed(1)}%</div>
      <div>总工具调用: {metrics.totalToolCalls}</div>
      <div>缓存命中: {metrics.cachedToolCalls}</div>
      <div>平均并发度: {metrics.avgConcurrentReads.toFixed(1)}</div>
    </div>
  );
}
```

## 实施计划

### 阶段1: 核心缓存层 (Week 1)
- [x] 设计工具结果缓存接口
- [ ] 实现 ToolResultCache 类
- [ ] 集成到 planningService.ts
- [ ] 添加缓存失效逻辑
- [ ] 单元测试

### 阶段2: 并发优化 (Week 1)
- [ ] 提升 MAX_PARALLEL_READ_TOOLS 到 15
- [ ] 提升 MAX_PARALLEL_SUB_AGENTS 到 5
- [ ] 添加性能配置系统
- [ ] 测试稳定性

### 阶段3: 专项缓存 (Week 2)
- [ ] 实现 GitCache
- [ ] 实现 DiagnosticsCache
- [ ] 集成到现有流程
- [ ] 失效机制测试

### 阶段4: 监控与优化 (Week 2)
- [ ] 实现性能指标收集
- [ ] 在 KitchenPage 添加性能面板
- [ ] 收集实际使用数据
- [ ] 根据数据调优参数

### 阶段5: 高级优化 (Week 3)
- [ ] 批量工具执行优化
- [ ] 智能预加载机制
- [ ] 自适应缓存策略
- [ ] 性能基准测试

## 预期效果

### 量化目标

| 指标 | 当前 | 目标 | 改进幅度 |
|------|------|------|---------|
| 工具调用总数 | 105次 | 45-60次 | -40~50% |
| 开发总时间 | 35分钟 | 15-20分钟 | -40~55% |
| 缓存命中率 | 0% | 60-70% | +60~70% |
| 平均并发度 | 3-4 | 8-12 | +100~200% |
| 重复读取率 | 35% | <10% | -70% |

### 用户体验改善

1. **响应速度**: 工具执行延迟降低50%
2. **资源效率**: CPU/内存使用更平滑
3. **大型项目**: 支持更大代码库（10000+文件）
4. **复杂任务**: 多文件修改任务耗时减半

## 风险与挑战

### 技术风险

1. **缓存一致性**: 缓存与文件系统状态不同步
   - 缓解: 严格的失效策略，保守的TTL

2. **并发竞态**: 高并发下的资源竞争
   - 缓解: 保持写操作串行，测试边界条件

3. **内存占用**: 缓存可能占用大量内存
   - 缓解: LRU淘汰，配置最大缓存大小

### 实施风险

1. **兼容性**: 可能影响现有功能
   - 缓解: 渐进式rollout，功能开关

2. **测试覆盖**: 复杂的并发场景难以测试
   - 缓解: 增加集成测试，压力测试

## 后续优化方向

### 短期 (v0.0.10 - v0.0.12)
1. 完成所有P0/P1优化
2. 收集性能数据验证效果
3. 根据反馈调优参数

### 中期 (v0.1.x)
1. 代码语义索引（向量搜索）
2. 智能文件推荐
3. 预测性预加载

### 长期 (v0.2.x+)
1. 并行Agent架构
2. 分布式缓存
3. 自适应性能调优

## 参考资料

1. **OpenCode**: https://github.com/OpenCode/opencode
2. **Aider**: https://github.com/paul-gauthier/aider
3. **Cursor**: 竞品分析文档
4. **LangChain Caching**: https://docs.langchain.com/docs/modules/model_io/models/llms/how_to/caching

---

**文档版本**: v1.0
**创建时间**: 2026-03-10
**作者**: Cofree Performance Team
**状态**: 设计完成，待实施
