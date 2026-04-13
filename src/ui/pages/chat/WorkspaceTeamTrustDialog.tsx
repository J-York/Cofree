import type { ReactElement } from "react";

import type { WorkspaceTeamTrustMode } from "../../../lib/workspaceTeamTrustStore";

export interface WorkspaceTeamTrustDialogProps {
  open: boolean;
  onChooseMode: (mode: WorkspaceTeamTrustMode) => void;
}

export function WorkspaceTeamTrustDialog({
  open,
  onChooseMode,
}: WorkspaceTeamTrustDialogProps): ReactElement | null {
  if (!open) {
    return null;
  }

  return (
    <div className="input-dialog-backdrop" role="presentation">
      <div
        className="input-dialog ask-user-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-team-trust-dialog-title"
      >
        <div className="ask-user-header">
          <h3
            id="workspace-team-trust-dialog-title"
            className="input-dialog-title"
          >
            当前工作区首次进入编排模式
          </h3>
        </div>

        <div className="ask-user-content">
          <div className="ask-user-question">
            <div className="ask-user-question-text">
              编排 YOLO 模式会在此工作区自动执行编排过程中主 Agent、子 Agent 与专家团产生的
              shell 与文件修改动作，不再逐条等待审批；未进入编排的单 Agent 对话仍保持原有审批行为。
            </div>
          </div>
        </div>

        <div className="input-dialog-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onChooseMode("team_yolo")}
          >
            启用该工作区编排 YOLO
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChooseMode("team_manual")}
          >
            继续使用审批模式
          </button>
        </div>
      </div>
    </div>
  );
}
