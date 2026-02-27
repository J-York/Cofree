#+#+#+#+markdown
# Cofree Git 支持范围（v0.1）

Git 是 MVP 的交付边界，也是风险黑洞。本文件用于锁死 v0.1 的支持范围与失败处理。

## 1. v0.1 支持矩阵（Support Matrix）

### 1.1 仓库类型
- ✅ 普通本地 Git 仓库（单 worktree）
- ❌ submodules（v0.1 不支持）
- ❌ Git LFS（v0.1 不支持）
- ❌ 自动解决 merge/rebase 冲突（v0.1 不支持）

### 1.2 读操作（默认允许）
- ✅ status
- ✅ diff（working tree / staged）
- ✅ 当前分支信息

### 1.3 写操作（必须走审批门）
- ✅ （可选）创建分支
- ✅ stage（按文件或全部）
- ✅ commit（必须二次确认）
- ❌ push（v0.1 默认不做；若做必须显式开关 + 审批）

## 2. 分支与提交策略（v0.1 建议）
- 默认在当前分支工作；若启用创建分支：`cofree/<date>/<slug>`
- commit message 由系统提议，用户可编辑，最终确认后执行

## 3. 失败处理（必须实现的 UX）
- patch apply 失败：展示失败原因（尽可能指明冲突位置），提供“一键回滚到 apply 前”
- stage/commit 失败：提示原因（例如未配置 user.name/email、index 锁、路径问题），并保持工作区不被破坏

## 4. 回滚最低标准
v0.1 至少支持：
- 将工作区恢复到 apply patch 前的状态（明确告知用户会丢弃哪些未保存更改）

## 5. 安全提示
- Git 写操作属于敏感动作，必须记录审计日志。
- 不允许在日志中记录凭据（token/remote url 中的 secret）。
