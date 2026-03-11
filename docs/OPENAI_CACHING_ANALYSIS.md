# OpenAI Chat Completions 缓存率分析

## 问题描述

使用 OpenAI Codex 模型（通过 chat completions 端点）时，远端 API 返回的缓存命中率较低（50-60%），低于使用 OpenAI 官方客户端的缓存率。

## OpenAI 缓存机制

与 Anthropic 不同，OpenAI 的缓存机制是**自动的**，主要通过以下方式优化：

### 1. Prompt Caching (自动)

OpenAI 在服务端自动缓存提示词前缀：
- 缓存基于**消息数组的前缀匹配**
- 当新请求的前 N 条消息与之前请求完全相同时，这些消息会被缓存
- 缓存命中会在响应的 `system_fingerprint` 字段中体现
- **不需要任何特殊的请求头或参数**

### 2. `seed` 参数（可选）

使用 `seed` 参数可以获得更确定性的输出和更好的缓存效果：
```json
{
  "model": "gpt-4",
  "messages": [...],
  "seed": 12345  // 固定的 seed 值
}
```

## 当前实现存在的问题

经过代码分析，发现以下可能导致缓存命中率低的问题：

### 1. **System Message 处理不一致** ❌

**代码位置**: `src/lib/litellm.ts` 行 906-918

```typescript
function toOpenAIChatMessages(messages: LiteLLMMessage[]): LiteLLMMessage[] {
  let seenNonSystem = false;
  return messages.map((msg) => {
    if (msg.role !== "system") {
      seenNonSystem = true;
      return msg;
    }
    if (!seenNonSystem) {
      return msg;  // 第一个 system 消息保持不变
    }
    // 后续 system 消息被转换为 user 消息！
    return { ...msg, role: "user" as const, content: `[System]\n${msg.content}` };
  });
}
```

**问题**：
- 将后续的 system 消息转换为 user 消息并添加 `[System]\n` 前缀
- 这会导致消息内容和结构发生变化，破坏缓存键的一致性
- OpenAI 官方客户端通常只允许一个 system 消息在开头，或者保持 system 消息的原始角色

**影响**：每次请求时，如果有多个 system 消息或 system 消息位置不同，会产生不同的消息数组，导致缓存失效。

### 2. **没有使用 `seed` 参数** ⚠️

当前实现没有在请求中包含 `seed` 参数。虽然这不是必需的，但使用固定的 `seed` 值可以：
- 提高输出的一致性
- 改善缓存命中率
- 便于调试和复现

### 3. **消息数组可能频繁变化** ⚠️

如果应用逻辑导致每次请求的消息历史都略有不同（例如时间戳、ID、动态内容等），会降低缓存命中率。

### 4. **缺少缓存监控** ❌

当前实现没有记录或展示 OpenAI 的缓存相关信息：
- `system_fingerprint` 字段（用于识别缓存命中）
- 没有追踪哪些请求使用了缓存

## 对比：官方客户端 vs 当前实现

| 特性 | OpenAI 官方客户端 | 当前实现 | 影响 |
|------|------------------|---------|------|
| System 消息处理 | 严格保持原始结构 | 转换后续 system 为 user | ❌ 破坏缓存键 |
| `seed` 参数 | 可选支持 | 不支持 | ⚠️ 失去确定性优势 |
| `system_fingerprint` 追踪 | 自动记录 | 未追踪 | ⚠️ 无法监控缓存 |
| 消息顺序 | 严格保持 | 可能变化（消息转换） | ❌ 影响缓存匹配 |
| 请求归一化 | 最小化变化 | 多层转换 | ⚠️ 增加不一致性 |

## 建议的改进方案

### 方案 1：修复 System Message 处理（推荐）

**目标**：保持消息数组的一致性，避免不必要的转换。

**改动**：
1. 移除 `toOpenAIChatMessages` 中的 system 消息转换逻辑
2. 或者确保应用层只发送一个 system 消息在开头
3. 如果必须有多个指令，合并成一个 system 消息

**优势**：
- ✅ 最大化缓存命中率
- ✅ 保持与 OpenAI API 规范的兼容性
- ✅ 最小代码改动

### 方案 2：添加 `seed` 参数支持

**目标**：提供可选的 `seed` 参数以提高确定性。

**改动**：
```typescript
export interface LiteLLMRequestOptions {
  responseFormat?: JsonSchemaResponseFormat;
  stream?: boolean;
  temperature?: number;
  tools?: LiteLLMToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  seed?: number;  // 新增
}

// 在 createLiteLLMRequestBody 中：
if (options?.seed !== undefined) {
  body.seed = options.seed;
}
```

**优势**：
- ✅ 提供更确定性的输出
- ✅ 改善缓存效果
- ✅ 向后兼容（可选参数）

### 方案 3：添加缓存监控

**目标**：追踪和展示缓存使用情况。

**改动**：
1. 在响应日志中记录 `system_fingerprint`
2. 对比连续请求的 fingerprint 来识别缓存命中
3. 在使用量统计中显示估算的缓存命中率

## 深入分析：为什么 System Message 转换会影响缓存

OpenAI 的缓存机制基于**消息数组的精确前缀匹配**：

```javascript
// 请求 A（能被缓存）
{
  messages: [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hello" }
  ]
}

// 请求 B（缓存命中 - 前缀完全相同）
{
  messages: [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
    { role: "user", content: "Tell me a joke" }
  ]
}

// 请求 C（缓存失效 - 前缀不同）
{
  messages: [
    { role: "user", content: "[System]\nYou are a helpful assistant" },  // ❌ 角色和内容都变了
    { role: "user", content: "Hello" }
  ]
}
```

当 `toOpenAIChatMessages` 将后续的 system 消息转换为 user 消息时：
1. 消息的 `role` 字段从 `"system"` 变为 `"user"`
2. 内容被添加了 `[System]\n` 前缀
3. 导致整个消息数组的结构和内容都发生变化
4. OpenAI 无法识别这与之前的请求是相同的前缀
5. 缓存失效，需要重新处理所有内容

## 测试计划

### 1. 验证当前行为

创建测试脚本验证消息转换如何影响请求：

```typescript
const messages = [
  { role: "system", content: "First system" },
  { role: "user", content: "User message" },
  { role: "system", content: "Second system" }  // 这会被转换
];

const transformed = toOpenAIChatMessages(messages);
console.log(JSON.stringify(transformed, null, 2));
```

### 2. 对比缓存命中率

- 测试 A：使用当前实现（有消息转换）
- 测试 B：移除消息转换逻辑
- 对比两者的 `system_fingerprint` 一致性

### 3. Seed 参数效果

- 测试 C：添加固定 seed 参数
- 验证输出的一致性和缓存效果

## 结论

导致 OpenAI Codex 缓存命中率低的主要原因是：

1. **System 消息转换**破坏了消息数组的一致性（主要原因）
2. 缺少 `seed` 参数支持（次要原因）
3. 缺少缓存监控机制（无法量化问题）

**推荐优先实施方案 1**，这将立即改善缓存命中率，且改动最小、风险最低。
