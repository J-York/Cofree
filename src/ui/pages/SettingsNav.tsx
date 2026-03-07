import type { ReactElement } from "react";
import { SETTINGS_TABS, type SettingsNavProps } from "./settingsTypes";

export function SettingsNav({ activeTab, onTabChange, onClose }: SettingsNavProps): ReactElement {
  return (
    <nav className="settings-nav">
      <div className="settings-nav-header">
        <span className="settings-nav-title">偏好设置</span>
        {onClose && (
          <button className="settings-close-btn" onClick={onClose} type="button">
            ×
          </button>
        )}
      </div>

      <div className="settings-nav-tabs">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`settings-tab-btn${activeTab === tab.id ? " active" : ""}`}
            onClick={() => onTabChange(tab.id)}
            type="button"
          >
            <span className="settings-tab-icon">
              {tab.id === "agents"
                ? "🧑‍💻"
                : tab.id === "model"
                  ? "🤖"
                  : tab.id === "tools"
                    ? "🛠"
                    : "⚙️"}
            </span>
            <span className="settings-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
