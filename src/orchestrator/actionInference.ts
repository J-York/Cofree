/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/actionInference.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Infer sensitive approval actions from user intent and plan steps.
 */

import type { ActionProposal } from "./types";

const WRITE_INTENT_HINTS = [
  "新增",
  "新建",
  "新加",
  "创建",
  "加一个",
  "写一个",
  "写个",
  "写入",
  "生成一个文件",
  "创建文件",
  "新增文件",
  "create file",
  "new file",
  "add file",
  "write a script",
  "write script",
  "implement",
  "修改",
  "修复",
  "删除",
  "重构",
  "编辑",
  "patch",
  "apply patch",
  "modify",
  "change",
  "edit",
  "fix",
  "refactor",
  "update",
  "remove file",
  "delete file",
  "rename"
];

const PATCH_HINTS = [
  "修改",
  "修复",
  "新增",
  "新建",
  "新加",
  "创建",
  "创建文件",
  "新增文件",
  "删除",
  "重构",
  "更新",
  "实现",
  "编辑",
  "写入",
  "补丁",
  "patch",
  "apply patch",
  "modify",
  "change",
  "edit",
  "fix",
  "implement",
  "refactor",
  "update",
  "add file",
  "create file",
  "remove file",
  "delete file",
  "rename"
];

const SHELL_HINTS = [
  "运行",
  "执行",
  "命令",
  "测试",
  "构建",
  "编译",
  "lint",
  "验证",
  "run",
  "execute",
  "command",
  "test",
  "build",
  "compile",
  "check",
  "validate",
  "pnpm",
  "npm",
  "cargo",
  "bun",
  "pytest",
  "git",
  "commit",
  "stage",
  "branch",
  "checkout",
  "rebase",
  "merge",
  "提交",
  "暂存",
  "分支",
  "切换分支"
];

function includesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function buildIntentCorpus(prompt: string): string {
  return prompt.toLowerCase();
}

export function hasWriteIntent(prompt: string): boolean {
  const corpus = buildIntentCorpus(prompt.trim());
  return includesAnyKeyword(corpus, WRITE_INTENT_HINTS);
}

export function inferSensitiveActions(prompt: string): ActionProposal[] {
  const normalizedPrompt = prompt.trim() || "approved changes";
  const corpus = buildIntentCorpus(normalizedPrompt);

  const needsPatch = hasWriteIntent(normalizedPrompt) || includesAnyKeyword(corpus, PATCH_HINTS);
  const needsShell = includesAnyKeyword(corpus, SHELL_HINTS);

  const actions: ActionProposal[] = [];

  if (needsPatch) {
    actions.push({
      id: "gate-a-apply-patch",
      type: "apply_patch",
      description: "Apply generated patch to workspace (Gate A)",
      gateRequired: true,
      status: "pending",
      executed: false,
      payload: {
        patch: ""
      }
    });
  }

  if (needsShell) {
    actions.push({
      id: "gate-b-shell",
      type: "shell",
      description: "Run shell command (Gate B)",
      gateRequired: true,
      status: "pending",
      executed: false,
      payload: {
        shell: "pnpm build",
        timeoutMs: 120000
      }
    });
  }

  return actions;
}
