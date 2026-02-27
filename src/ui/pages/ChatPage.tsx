/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/ChatPage.tsx
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Chat page with mock plan generation for orchestration preview.
 */

import { type ReactElement, useMemo, useState } from "react";
import { DEFAULT_AGENTS } from "../../agents/defaultAgents";
import { draftPlanFromPrompt } from "../../orchestrator/mockOrchestrator";

export function ChatPage(): ReactElement {
  const [prompt, setPrompt] = useState("给设置页补一个 API Key 持久化能力");

  const previewPlan = useMemo(() => draftPlanFromPrompt(prompt), [prompt]);

  return (
    <div className="page-stack">
      <article className="panel-card">
        <h2>点单区</h2>
        <p className="status-note">Milestone 1 先提供计划预览，不触发真实写盘或命令执行。</p>
        <textarea
          className="textarea"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述你希望 Cofree 执行的任务"
        />
      </article>

      <article className="panel-card">
        <h3>编排计划预览</h3>
        <ol>
          {previewPlan.steps.map((step) => (
            <li key={step.id} className="plan-item">
              {step.summary} ({step.owner})
            </li>
          ))}
        </ol>
        <p className="status-note">敏感动作（均需审批门）：</p>
        <ul>
          {previewPlan.proposedActions.map((action) => (
            <li key={action.id}>{action.type}: {action.description}</li>
          ))}
        </ul>
      </article>

      <article className="panel-card">
        <h3>默认专家团队</h3>
        <ul>
          {DEFAULT_AGENTS.map((agent) => (
            <li key={agent.role}>
              {agent.displayName}: {agent.promptIntent}
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}
