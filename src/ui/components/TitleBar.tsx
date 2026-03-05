import { type ReactElement } from "react";
import { WindowControls } from "./WindowControls";
import { IconSettings, IconPanelBottom, IconBranch, IconFolder } from "./Icons";

interface TitleBarProps {
  workspacePath: string;
  gitBranch?: string;
  currentModel?: string; // Add currentModel to props
  onToggleKitchen: () => void;
  onToggleSettings: () => void;
  kitchenOpen: boolean;
}

export function TitleBar({
  workspacePath,
  gitBranch,
  currentModel,
  onToggleKitchen,
  onToggleSettings,
  kitchenOpen,
}: TitleBarProps): ReactElement {
  const folderName = workspacePath
    ? workspacePath.split("/").pop() || workspacePath
    : "";

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="titlebar-brand" data-tauri-drag-region>Cofree</span>
        {folderName && (
          <div className="titlebar-workspace">
            <IconFolder size={12} />
            <span className="titlebar-workspace-name">{folderName}</span>
            {gitBranch && (
              <>
                <span className="titlebar-sep">/</span>
                <IconBranch size={12} />
                <span className="titlebar-branch">{gitBranch}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Center Model Display */}
      {currentModel && (
        <div className="titlebar-center" data-tauri-drag-region>
          <div className="titlebar-model-badge">
            <span className="titlebar-model-dot" />
            <span className="titlebar-model-text">{currentModel}</span>
          </div>
        </div>
      )}

      <div className="titlebar-right">
        <button
          className={`titlebar-btn${kitchenOpen ? " active" : ""}`}
          onClick={onToggleKitchen}
          type="button"
          title="控制台 (⌘J)"
        >
          <IconPanelBottom size={14} />
        </button>
        <button
          className="titlebar-btn"
          onClick={onToggleSettings}
          type="button"
          title="设置 (⌘,)"
        >
          <IconSettings size={15} />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
