/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/KitchenPage.tsx
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Placeholder kitchen status board for future milestone expansion.
 */

import type { ReactElement } from "react";

export function KitchenPage(): ReactElement {
  return (
    <div className="page-stack">
      <article className="panel-card">
        <h2>厨房（占位）</h2>
        <p className="status-note">
          Milestone 2 起会接入真实 orchestrator 状态机（planning → executing → human_review → done）。
        </p>
      </article>
      <article className="panel-card">
        <h3>当前状态板（Mock）</h3>
        <ul>
          <li>Planner: Ready</li>
          <li>Coder: Waiting for task</li>
          <li>Tester: Waiting for diff</li>
        </ul>
      </article>
    </div>
  );
}
