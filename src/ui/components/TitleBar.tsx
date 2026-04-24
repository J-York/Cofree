import { type ReactElement, useEffect, useRef, useState } from "react";
import { WindowControls } from "./WindowControls";
import { IconSettings, IconTerminal, IconBranch, IconFolder, IconSun, IconMoon, IconMonitor, IconSidebar } from "./Icons";
import { useTheme, getThemeLabel, getNextTheme, type ThemeMode } from "../../hooks/useTheme";

interface TitleBarModelOption {
  vendorId: string;
  modelId: string;
  vendorName: string;
  modelName: string;
}

interface TitleBarProps {
  workspacePath: string;
  recentWorkspaces: string[];
  gitBranch?: string;
  currentModel?: string;
  modelOptions: TitleBarModelOption[];
  activeModelId: string | null;
  onOpenSystemTerminal: () => void;
  onToggleSettings: () => void;
  onSwitchModel: (modelId: string) => void;
  onSelectWorkspace: () => void;
  onSwitchWorkspace: (workspacePath: string) => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

function getWorkspaceLabel(workspacePath: string): string {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workspacePath;
}

function shortenModelName(model: string): string {
  let id = model.includes(":") ? (model.split(":").pop() ?? model) : model;
  id = id.replace(/-\d{8}$/, "");
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  id = id.replace(/^claude-/, "");
  id = id.replace(/(\d)-(\d)(?!\d)/g, "$1.$2");
  return id;
}

function ThemeIcon({ theme }: { theme: ThemeMode }): ReactElement {
  switch (theme) {
    case "dark":
      return <IconMoon size={14} />;
    case "light":
      return <IconSun size={14} />;
    case "system":
      return <IconMonitor size={14} />;
  }
}

function ThemeToggleButton(): ReactElement {
  const { theme, setTheme } = useTheme();
  const label = getThemeLabel(theme);

  const handleClick = () => {
    setTheme(getNextTheme(theme));
  };

  return (
    <button
      className="titlebar-btn"
      onClick={handleClick}
      type="button"
      title={`主题: ${label}`}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

export function TitleBar({
  workspacePath,
  recentWorkspaces,
  gitBranch,
  currentModel,
  modelOptions,
  activeModelId,
  onOpenSystemTerminal,
  onToggleSettings,
  onSwitchModel,
  onSelectWorkspace,
  onSwitchWorkspace,
  onToggleSidebar,
  sidebarCollapsed,
}: TitleBarProps): ReactElement {
  const folderName = workspacePath ? getWorkspaceLabel(workspacePath) : "";

  const [modelPopover, setModelPopover] = useState(false);
  const [wsPopover, setWsPopover] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelPopover(false);
      }
      if (wsRef.current && !wsRef.current.contains(e.target as Node)) {
        setWsPopover(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const displayModel = currentModel ? shortenModelName(currentModel) : "未配置模型";
  const modelTooltip = currentModel ?? undefined;
  const recentWorkspaceOptions = recentWorkspaces.filter((path) => path !== workspacePath);
  const workspaceActionLabel = workspacePath ? "更换工作区…" : "选择工作区…";

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <button
          className={`titlebar-btn titlebar-sidebar-btn${sidebarCollapsed ? "" : " active"}`}
          onClick={onToggleSidebar}
          type="button"
          title="对话列表 (⌘B)"
        >
          <IconSidebar size={14} />
        </button>
        <div className="titlebar-workspace-wrap" ref={wsRef}>
          <div
            className={`titlebar-workspace${wsPopover ? " active" : ""}`}
            onClick={() => { setWsPopover((value) => !value); setModelPopover(false); }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setWsPopover((value) => !value); }}
          >
            <IconFolder size={12} />
            <span className="titlebar-workspace-name">
              {folderName || "选择工作区"}
            </span>
            {gitBranch && (
              <>
                <span className="titlebar-sep">/</span>
                <IconBranch size={12} />
                <span className="titlebar-branch">{gitBranch}</span>
              </>
            )}
            <svg className="titlebar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {wsPopover && (
            <div className="titlebar-popover titlebar-popover-ws">
              <div className="titlebar-popover-header">工作区</div>
              {workspacePath ? (
                <div className="titlebar-popover-item current">
                  <div className="titlebar-popover-item-info">
                    <span className="titlebar-popover-item-name">{folderName}</span>
                    <span className="titlebar-popover-item-detail">{workspacePath}</span>
                  </div>
                </div>
              ) : (
                <div className="titlebar-popover-empty">尚未选择工作区</div>
              )}
              {recentWorkspaceOptions.length > 0 && (
                <>
                  <div className="titlebar-popover-divider" />
                  <div className="titlebar-popover-header">最近使用</div>
                  <div className="titlebar-popover-list">
                    {recentWorkspaceOptions.map((path) => (
                      <button
                        key={path}
                        className="titlebar-popover-option"
                        onClick={() => {
                          onSwitchWorkspace(path);
                          setWsPopover(false);
                        }}
                        type="button"
                      >
                        <div className="titlebar-popover-option-dot" />
                        <div className="titlebar-popover-option-info">
                          <span className="titlebar-popover-option-name">
                            {getWorkspaceLabel(path)}
                          </span>
                          <span className="titlebar-popover-option-model">{path}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="titlebar-popover-divider" />
              <button
                className="titlebar-popover-action"
                onClick={() => { setWsPopover(false); onSelectWorkspace(); }}
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 7L7 2L12 7M7 2V12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" transform="rotate(0 7 7)"/>
                  <rect x="1.5" y="1.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                </svg>
                {workspaceActionLabel}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <div className="titlebar-model-wrap" ref={modelRef}>
          <div
            className={`titlebar-model-badge${modelPopover ? " active" : ""}`}
            onClick={() => { setModelPopover((value) => !value); setWsPopover(false); }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setModelPopover((value) => !value); }}
          >
            <span className="titlebar-model-name" title={modelTooltip}>{displayModel}</span>
            <svg className="titlebar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {modelPopover && (
            <div className="titlebar-popover titlebar-popover-model">
              <div className="titlebar-popover-header">切换模型</div>
              {modelOptions.length > 0 ? (
                <div className="titlebar-popover-list">
                  {modelOptions.map((option) => {
                    const isActive = option.modelId === activeModelId;
                    return (
                      <button
                        key={option.modelId}
                        className={`titlebar-popover-option${isActive ? " active" : ""}`}
                        onClick={() => {
                          if (!isActive) onSwitchModel(option.modelId);
                          setModelPopover(false);
                        }}
                        type="button"
                      >
                        <div className={`titlebar-popover-option-dot${isActive ? " active" : ""}`} />
                        <div className="titlebar-popover-option-info">
                          <span className="titlebar-popover-option-name">{option.modelName}</span>
                          <span className="titlebar-popover-option-model">{option.vendorName}</span>
                        </div>
                        {isActive && (
                          <svg className="titlebar-popover-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M3 7.5L5.5 10L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="titlebar-popover-empty">尚未配置模型</div>
              )}
              <div className="titlebar-popover-divider" />
              <button
                className="titlebar-popover-action"
                onClick={() => { setModelPopover(false); onToggleSettings(); }}
                type="button"
              >
                <IconSettings size={13} />
                管理配置…
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="titlebar-right">
        <button
          className="titlebar-btn"
          onClick={onOpenSystemTerminal}
          type="button"
          title="在系统终端打开工作区 (⌘J)"
        >
          <IconTerminal size={14} />
        </button>
        <ThemeToggleButton />
        <div className="titlebar-actions-sep" aria-hidden />
        <button
          className="titlebar-btn"
          onClick={onToggleSettings}
          type="button"
          title="设置 (⌘,)"
        >
          <IconSettings size={14} />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
