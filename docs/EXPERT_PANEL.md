# 专家组（虚拟专家团）功能说明

Cofree 的「专家组」是**形态 A：编排内虚拟专家团**——用户主要与一名**接待型顶层 Agent**对话，由它通过 `task` 工具委派给内置子角色（planner / coder / tester / debugger / reviewer）或预置 **Agent Team** 流水线，最后由接待 Agent 汇总回复用户。

这不是多人实时协作或真人专家进群；所有推理与工具调用仍在本地工作区与用户配置的模型端点完成。

## 使用方式

1. 在聊天页 Agent 选择器中选择 **「专家组接待」**（`agent-concierge`）。
2. 用自然语言描述需求；接待 Agent 应优先通过 `task(role=...)` 或 `task(team=...)` 委派，再基于子 Agent / Team 返回结果向用户汇报。
3. **默认闭环**预置团队 `team-expert-panel-v2`：需求对齐（planner）→ 实现（coder）→ 审查（reviewer）→（审查有问题时）审查修复（coder）→ 测试（tester）→（测试未通过时）测试修复（coder）→（仅当发生过测试修复时）测试复验（tester）。`team-expert-panel` 仍为轻量三阶段（无测试/复验），可按需选用。
4. `task(team=...)` 工具结果 JSON 含 `stop_reason`（如 `completed_normal`、`budget_exhausted`、`stage_failed`、`aborted`）、`next_recommended_action`、`repair_rounds_used`、`routing_mode`（当前固定为 `builtin_pipeline`，为后续动态路由预留）。
5. `team-expert-panel-v2` 在 planner 成功结束后会发出 `team_checkpoint` 进度事件（不暂停执行），便于 UI 提示用户确认计划后再进入实现。

## 与多 Agent 整改（P0/P1）的关系

专家团**加重**了 `task` 与 Team 的使用，因此与 [MULTI_AGENT_REMEDIATION_PLAN.md](./MULTI_AGENT_REMEDIATION_PLAN.md) 中的目标一致：

| 整改项 | 对专家团的意义 |
|--------|----------------|
| P0-2 `task(team)` 与 `allowedSubAgents` 一致 | 受限顶层 Agent 不能通过 Team 间接调用未授权子角色 |
| P0-3 `handoffPolicy` | 接待 Agent 使用 `sequential`：可委派，且多 `task` 串行执行，行为可预测 |
| P1-1～P1-3 父子结果与 success 语义 | 子阶段产生的动作与失败状态能正确回到父层审批与续跑 |

详细实现状态见 [MULTI_AGENT_REMEDIATION_PLAN.md](./MULTI_AGENT_REMEDIATION_PLAN.md) 第 13 节与 [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)。

## 形态 B：多说话人时间线（可选）

在消息模型中支持 `assistantSpeaker` 与 **Team 阶段完成**时注入的简要合成消息，用于在会话中区分「专家阶段小结」与接待主回复；若当前最后一条可见消息不是 assistant（例如用户插话），阶段小结会**追加**到列表末尾以免丢失。完整产品与迁移策略见实现代码注释及 `chatHistoryStore` 的字段说明。
