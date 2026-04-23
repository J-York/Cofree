# Chat UI 重设计计划

## 背景

当前聊天页在单条 assistant 消息上堆了最多 5 张视觉权重相近的卡片，正文（`chat-bubble`）被埋在下面；同一份"工具发生了什么"的信息被切成 3 种 UI 表达（`AssistantToolCalls` / `LiveToolStatus` / `ToolTracePanel`）；状态在 badge / step 颜色 / 按钮态三处重复表达。

## 诊断：单条 assistant 消息今天的视觉栈

```
[头像] [meta 行]
       [AssistantToolCalls — debug 卡]      ← 工具调用呈现 #1
       [LiveToolStatus — 流式 spinner 卡]    ← 工具调用呈现 #2
       [ToolTracePanel — 折叠链路卡]         ← 工具调用呈现 #3
       [InlinePlan — 执行计划卡]              ← 计划/进度
         └─ [plan-step 卡]
              └─ [action-item 卡] ← 审批
       [chat-bubble — 正文]                   ← 真正的信息
       [ContextAttachmentPills]
```

## 设计原则

> **聊天页是一份流式的工作记录，不是一摞功能面板。**
>
> 正文（bubble）是主角；工具活动是底下的"日志带"；只有需要按按钮的事情才允许跳出来变成卡片。

| 层级 | 视觉权重 | 谁能占用 |
|---|---|---|
| 主体 | bubble — 圆角、有背景 | LLM 的语言输出 |
| 副线 | 单行 mono 时间轴 — 无背景，只有 1px 左竖线 + 字符 glyph | 已完成/进行中的工具调用 |
| 跳出 | 卡片 — 有边框背景、12px padding | **只有等你审批的东西**（pending action） |
| 角标 | 头像/meta 行右侧的 1 字符 glyph | 阶段（思考中●/执行中◐/等审批▲/完成✓） |

## 具体重设计

### A. Meta 行 — 信息密度提一倍

- **现状**：`你 · 14:32`
- **改后**：`你 · 14:32 · gpt-4 · 2.1k tokens · ●thinking`
- 角色/时间/模型/本轮 tokens/状态 glyph 都进 meta 行的 mono 字体里
- **LiveToolStatus 整张卡彻底删掉**，状态收到 meta 行末尾

### B. 工具调用 — 三合一变成一条"活动带"

干掉 `AssistantToolCalls` / `LiveToolStatus` / `ToolTracePanel` 三个组件，统一成 `ActivityRail`：

```
│ ✓ read_file  src/agents/promptAssembly.ts                   12ms
│ ✓ grep       "update_plan" in src/                          8ms
│ ◐ propose_shell  pnpm test ...                              ↗ 待审批
│ ✓ read_file  src/orchestrator/planningService.ts            18ms
```

- 1px 左竖线 + 单行；无背景、无圆角、无 padding
- 默认显示"工具名 + 一行参数摘要"
- 点单行就地展开成可折叠的详细 trace（stdout/stderr/diff 内嵌）
- debug 模式只是把行右侧多一个原始 JSON 入口，不再独立组件

### C. 计划 — 默认隐藏，只在多步骤时浮现

- **0 步骤**：完全不渲染（跟现在一样）
- **1 步骤 + 1 action**：直接渲染 action 紧凑卡（已完成，见 `ChatPresentational.tsx:817-836`）
- **2+ 步骤**：在活动带顶上加一行 `▸ 3 步 · 1 完成 · 2 待办`，点击展开。**不再有独立"执行计划"标题区块**
- "执行计划"四个字本身删掉——这是给开发者看的内部名词，用户只关心"还有几步"

### D. 审批卡 — 唯一允许"大"的东西

保留现在的 `action-item` 视觉权重，但：
- 不套在 `inline-plan` 容器里
- footer 按钮压扁：审批/拒绝/备注 三个按钮 → 一个分段控件 `[ 批准 ▾ ]`，下拉里放"批准并记住此类"和"拒绝"
- diff / 命令预览默认折叠，点开才展开

### E. 用户消息 — 极简化

- 没必要重复显示头像（你已经知道是自己发的）；让 user 消息靠右、没头像，像 iMessage
- `ContextAttachmentPills` 在 user bubble 内 inline 显示就够，不需要 compact / non-compact 两套样式

### F. ChatComposer — 顶部状态栏 + 底部输入合并

- `TokenUsageRing` 从 composer 底部挪到 meta 行（见 A）
- Composer 只剩输入 + 提交按钮 + 错误条

## 主要权衡

| 方向 | 收益 | 代价 |
|---|---|---|
| 工具活动改成单行时间轴 | 同一条消息视觉重量降 70% | 失去当前 trace 面板那种"分组卡片"的辨识度，调试时要多点一下才能看 stdout |
| 删掉"执行计划"标题 | 少一处冗余术语 | 多步任务时用户不再有"哦它在按计划走"的安全感 |
| LiveToolStatus 收到 meta 行 | 卡片总数 −1 | 多个并行工具时单字符 glyph 的信息量不够 |

## 执行顺序

### Phase 1 — 减卡（半天）

**目标**：一眼舒服。

- 删 `LiveToolStatus` 独立卡，状态收到 meta 行
- `ToolTracePanel` 改成无背景 mono 时间轴（`ActivityRail` 雏形）

**涉及文件**：
- `src/ui/pages/chat/ChatPresentational.tsx`（`LiveToolStatus` 组件 & meta 行）
- `src/ui/pages/chat/ChatThreadSection.tsx:150-160`（条件渲染）
- `src/styles/features/chat/*.css`

### Phase 2 — 整合 plan

**目标**：多步任务不再有独立的"执行计划"卡片。

- 把 `InlinePlan` 的"标题 / 步骤 / 未关联动作"三段合并成"一行 summary + 内嵌 action"
- 删掉"执行计划"四个字
- 步骤展开由 activity rail 顶部的 `▸ N 步` 单行承载

**涉及文件**：
- `src/ui/pages/chat/ChatPresentational.tsx:732-1072`（`InlinePlan` 组件）
- `src/styles/features/tools/plan.css`

### Phase 3 — Composer / 用户消息

**目标**：输入区和历史消息都变轻。

- meta 行升级：加模型 / tokens / 阶段 glyph
- `TokenUsageRing` 上移到 meta 行
- user 消息去头像，右对齐

**涉及文件**：
- `src/ui/pages/chat/composer/ChatComposer.tsx`
- `src/ui/pages/chat/ChatThreadSection.tsx`
- `src/styles/features/chat/bubble.css`

### Phase 4 — 审批卡精简

**目标**：唯一保留的"大"卡片也要干净。

- 审批按钮合并成分段控件 `[ 批准 ▾ ]`
- diff / 命令预览默认折叠
- "记住此类"作为下拉项而非独立 checkbox

**涉及文件**：
- `src/ui/pages/chat/ChatPresentational.tsx:575-730`（`PlanActionCard`）
- `src/styles/features/tools/plan.css:145-200`

## 已完成的铺垫

- **单 action 紧凑形态**：`ChatPresentational.tsx:817-836` 已加 early return，`steps.length === 0 && proposedActions.length === 1` 时直接渲染单张 `PlanActionCard`，不套 `.inline-plan` 容器
- **系统提示裁剪**：`src/agents/promptAssembly.ts` 已移除鼓励调用 `update_plan` 的所有措辞，简单任务 LLM 不再主动拆三步 TODO

## 开放问题

- 并行工具（`Promise.all` 式）在单行时间轴里怎么表达？考虑过缩进+同一时间戳分组，但信息量偏弱
- debug 模式下的 raw JSON 入口放行尾还是放底部折叠？影响排版一致性
- iMessage 式右对齐 user 消息在窄窗口（<600px）下会不会挤压 context pills？需要实机验证
