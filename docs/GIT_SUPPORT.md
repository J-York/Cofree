# Cofree Git 支持范围（v0.0.2）— 实际实现修订版

Git 是 MVP 的交付边界，也是风险黑洞。本文件锁定 v0.1 的支持范围与失败处理。

## 1. v0.1 支持矩阵（Support Matrix）

### 1.1 仓库类型
- ✅ 普通本地 Git 仓库（单 worktree）
- ❌ submodules（v0.1 不支持）
- ❌ Git LFS（v0.1 不支持）
- ❌ 自动解决 merge/rebase 冲突（v0.1 不支持）

### 1.2 读操作（默认允许，通过只读工具）
- ✅ `git_status` — 查看工作区状态（modified, added, deleted, untracked）
- ✅ `git_diff` — 查看 working tree diff（可指定文件）
- ✅ 当前分支信息（通过 git2 库获取）

### 1.3 写操作（通过 propose_shell 审批门）
- ✅ 创建分支：`git checkout -b <branch>`
- ✅ Stage：`git add <files>`
- ✅ Commit：`git commit -m "message"`
- ❌ Push（v0.1 不支持自动 push）

> 注：v0.1 的 Git 写操作通过 `propose_shell`（Gate B）统一处理，而非独立的 Gate C 审批门。
> LLM 提出 git 命令 → 用户在 UI 中看到完整命令并审批 → 系统执行。

## 2. 分支与提交策略（v0.0.2）
- 默认在当前分支工作
- 分支创建通过 `propose_shell` 执行 `git checkout -b cofree/<slug>`
- Commit message 由 LLM 生成，用户在审批命令时可看到完整命令

## 3. 失败处理（已实现的 UX）
- **Patch apply 失败**：展示失败原因，自动从快照回滚到 apply 前状态
- **Shell 命令失败**：展示 stderr/exit code，不影响工作区状态
- **Git 命令失败**（如未配置 user.name/email）：通过 shell stderr 展示原因

## 4. 回滚最低标准
- 将工作区恢复到 apply patch 前的状态（通过 `~/.cofree/snapshots/` 文件快照）
- 快照机制支持 tracked 和 untracked 文件
- 不依赖 git HEAD 存在

## 5. 安全提示
- Git 写操作通过 propose_shell 执行，属于敏感动作，必须经过审批门
- 所有 shell 执行记录到审计日志
- 不允许在日志中记录凭据（token/remote url 中的 secret）
