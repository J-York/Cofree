# Anthropic Prompt Caching 实现说明

## 问题背景

在接入支持远端缓存的 API（如 Anthropic Claude API）时，发现远端 API 返回的缓存率较低（约 50-60%），低于使用官方客户端的缓存率。

## 根本原因

项目之前**没有实现 Anthropic 的 Prompt Caching 功能**。虽然 Anthropic API 支持提示缓存，但需要：

1. 在请求头中添加特定的 beta 功能标识
2. 在请求体的 system prompt 中添加 `cache_control` 标记
3. 使用正确的消息格式来标记可缓存内容

## 解决方案

### 1. 添加 Prompt Caching Beta 头部

在 TypeScript 和 Rust 层都添加了必要的 HTTP 头部：

```typescript
// src/lib/litellm.ts
headers["anthropic-beta"] = "prompt-caching-2024-07-31";
```

```rust
// src-tauri/src/commands/http.rs
request = request.header("anthropic-beta", "prompt-caching-2024-07-31");
```

### 2. 格式化 System Prompt 以支持缓存

修改了 `toAnthropicMessages` 函数，将 system prompt 转换为支持缓存的数组格式：

```typescript
// 之前：system prompt 是纯字符串
{ system: "long system prompt...", messages: [...] }

// 现在：system prompt 是带缓存控制的数组
{
  system: [
    {
      type: "text",
      text: "long system prompt...",
      cache_control: { type: "ephemeral" }
    }
  ],
  messages: [...]
}
```

### 3. 智能缓存阈值

为了避免不必要的缓存成本，只有当 system prompt 超过 1024 字符时才启用缓存：

```typescript
if (systemText.length > 1024) {
  systemContent = [
    {
      type: "text",
      text: systemText,
      cache_control: { type: "ephemeral" },
    },
  ];
} else {
  systemContent = systemText;
}
```

**原因**：
- Anthropic 对缓存内容收费（虽然比正常输入便宜）
- 短提示词缓存收益不明显
- 避免为小型请求增加不必要的开销

### 4. 缓存使用统计

更新了使用量跟踪，添加了缓存相关指标：

- `cache_creation_input_tokens`：创建缓存消耗的 token 数
- `cache_read_input_tokens`：从缓存读取的 token 数

这些指标会在日志中显示，便于监控缓存效果。

## 预期效果

实现 Prompt Caching 后，应该能看到：

1. **更高的缓存命中率**：对于重复或相似的请求，system prompt 会被缓存
2. **降低 token 消耗**：缓存命中时，不需要重新处理 system prompt
3. **更快的响应速度**：缓存内容的处理速度更快
4. **降低成本**：缓存读取比正常输入便宜 90%

### 成本分析

以 Claude 3.5 Sonnet 为例：
- 正常输入：$3.00 / 1M tokens
- 缓存写入：$3.75 / 1M tokens（首次创建缓存）
- 缓存读取：$0.30 / 1M tokens（90% 折扣）

假设 system prompt 为 2000 tokens，10 次请求：
- **无缓存**：10 × 2000 × $3.00 = $0.06
- **有缓存**：1 × 2000 × $3.75 + 9 × 2000 × $0.30 = $0.0615

看起来成本略高，但实际上：
- 缓存持续 5 分钟，更多请求会进一步降低平均成本
- 响应速度提升带来的用户体验改善
- 降低 API 限流风险（因为实际处理的 token 更少）

## 使用建议

1. **适合缓存的场景**：
   - 长的 system prompt（>1024 字符）
   - 高频请求（5 分钟内多次使用相同的 system prompt）
   - 工具定义和其他重复性高的内容

2. **不适合缓存的场景**：
   - 短的 system prompt（<1024 字符）
   - 低频请求（每次请求间隔 >5 分钟）
   - 频繁变化的 system prompt

3. **监控缓存效果**：
   - 查看控制台日志中的 `usage` 字段
   - 关注 `cache_read_input_tokens` 的值
   - 计算缓存命中率：`cache_read / (input_tokens + cache_read)`

## 技术细节

### 缓存生命周期

- 缓存在首次创建后保持 **5 分钟**
- 每次缓存命中会刷新生命周期
- 5 分钟后缓存过期，下次请求需要重新创建

### 缓存键计算

Anthropic 根据以下内容计算缓存键：
- 完整的 system prompt 内容
- 所有带 `cache_control` 标记的内容块
- 内容的顺序和格式

**重要**：system prompt 的任何微小变化都会导致缓存失效。

## 测试

运行测试脚本验证实现：

```bash
npx tsx test-cache-implementation.ts
```

预期输出应显示：
- ✓ System prompt is array (cache-enabled format)
- ✓ cache_control present: {"type":"ephemeral"}
- ✓ System prompt is string (cache not enabled for short content)

## 参考资料

- [Anthropic Prompt Caching 官方文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Prompt Caching 最佳实践](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#cache-prefixes)
