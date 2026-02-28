/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/KitchenPage.tsx
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Kitchen status board aligned with milestone-3 HITL workflow states.
 */

import type { ReactElement } from "react";

export function KitchenPage(): ReactElement {
  return (
    <div className="page-stack">
      <article className="panel-card">
        <h2>厨房（Milestone 3）</h2>
        <p className="status-note">
          当前工作流已进入 HITL：`planning → executing → human_review → done`。
        </p>
      </article>
      <article className="panel-card">
        <h3>当前状态板</h3>
        <ul>
          <li>Planner: Planning actions</li>
          <li>Coder: Waiting for approval gate</li>
          <li>Tester: Waiting for command execution result</li>
        </ul>
      </article>
    </div>
  );
}
