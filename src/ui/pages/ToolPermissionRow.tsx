import type { ReactElement } from "react";
import { type ToolPermissionLevel } from "../../lib/settingsStore";
import type { ToolPermissionRowProps } from "./settingsTypes";

export function ToolPermissionRow({
  toolKey,
  description,
  value,
  onChange,
}: ToolPermissionRowProps): ReactElement {
  return (
    <div className="tool-permission-row">
      <div className="tool-permission-info">
        <span className="tool-permission-name">{toolKey}</span>
        <span className="tool-permission-desc">{description}</span>
      </div>
      <div className="tool-permission-toggle">
        {(["auto", "ask"] as ToolPermissionLevel[]).map((option) => (
          <button
            key={option}
            className={`tool-toggle-btn${value === option ? " active" : ""}`}
            onClick={() => onChange(option)}
            type="button"
          >
            {option === "auto" ? "Auto" : "Ask"}
          </button>
        ))}
      </div>
    </div>
  );
}
