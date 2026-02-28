import type { ReactElement } from "react";

const AGENTS = [
  {
    icon: "🧠",
    name: "Planner",
    role: "规划师",
    status: "planning",
    statusLabel: "规划动作中",
    statusClass: "badge-warning",
  },
  {
    icon: "💻",
    name: "Coder",
    role: "编码员",
    status: "waiting",
    statusLabel: "等待审批门",
    statusClass: "badge-default",
  },
  {
    icon: "🧪",
    name: "Tester",
    role: "测试员",
    status: "waiting",
    statusLabel: "等待执行结果",
    statusClass: "badge-default",
  },
];

const FLOW_STEPS = ["planning", "executing", "human_review", "done"];

export function KitchenPage(): ReactElement {
  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">厨房</h1>
        <p className="page-subtitle">HITL 工作流状态看板 · Milestone 3</p>
      </div>

      {/* Workflow flow */}
      <div className="card">
        <p className="card-title">当前工作流</p>
        <div className="kitchen-flow">
          {FLOW_STEPS.map((step, i) => (
            <div key={step} className="kitchen-flow-step">
              <span className={`kitchen-flow-label${step === "planning" ? " active" : ""}`}>
                {step}
              </span>
              {i < FLOW_STEPS.length - 1 && (
                <span className="kitchen-flow-arrow">→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Agent cards */}
      <div className="kitchen-grid">
        {AGENTS.map((agent) => (
          <div key={agent.name} className="kitchen-agent-card">
            <div className="kitchen-agent-icon">{agent.icon}</div>
            <div>
              <h3 className="kitchen-agent-name">{agent.name}</h3>
              <p className="kitchen-agent-status">{agent.role}</p>
            </div>
            <span className={`badge ${agent.statusClass}`}>{agent.statusLabel}</span>
          </div>
        ))}
      </div>

      {/* Info card */}
      <div className="card card-sm">
        <p className="card-title">说明</p>
        <p className="status-note" style={{ lineHeight: 1.7 }}>
          厨房看板展示 AI 多智能体协作状态。Planner 负责分解任务并生成动作提案，
          Coder 等待用户在聊天区审批后执行，Tester 在执行完成后验证结果。
          所有敏感动作均需经过 HITL（Human-in-the-Loop）审批门。
        </p>
      </div>
    </div>
  );
}
