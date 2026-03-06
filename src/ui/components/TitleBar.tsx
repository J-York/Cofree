import { type ReactElement, useEffect, useRef, useState } from "react";
import { WindowControls } from "./WindowControls";
import { IconSettings, IconPanelBottom, IconBranch, IconFolder } from "./Icons";
import type { ChatAgentDefinition } from "../../agents/types";

interface TitleBarModelOption {
  vendorId: string;
  modelId: string;
  vendorName: string;
  modelName: string;
}

interface TitleBarProps {
  workspacePath: string;
  gitBranch?: string;
  currentModel?: string;
  modelOptions: TitleBarModelOption[];
  activeModelId: string | null;
  agents: ChatAgentDefinition[];
  activeAgentId: string | null;
  onToggleKitchen: () => void;
  onToggleSettings: () => void;
  onSwitchModel: (modelId: string) => void;
  onSwitchAgent: (agentId: string) => void;
  onSelectWorkspace: () => void;
  kitchenOpen: boolean;
}

export function TitleBar({
  workspacePath,
  gitBranch,
  currentModel,
  modelOptions,
  activeModelId,
  agents,
  activeAgentId,
  onToggleKitchen,
  onToggleSettings,
  onSwitchModel,
  onSwitchAgent,
  onSelectWorkspace,
  kitchenOpen,
}: TitleBarProps): ReactElement {
  const folderName = workspacePath
    ? workspacePath.split("/").pop() || workspacePath
    : "";

  const [agentPopover, setAgentPopover] = useState(false);
  const [wsPopover, setWsPopover] = useState(false);
  const agentRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (agentRef.current && !agentRef.current.contains(e.target as Node)) {
        setAgentPopover(false);
      }
      if (wsRef.current && !wsRef.current.contains(e.target as Node)) {
        setWsPopover(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const displayModel = currentModel ? currentModel.split(/[:/]/).pop() : "未配置模型";

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="titlebar-brand" data-tauri-drag-region>Cofree</span>
        <div className="titlebar-workspace-wrap" ref={wsRef}>
          <div
            className={`titlebar-workspace${wsPopover ? " active" : ""}`}
            onClick={() => { setWsPopover((value) => !value); setAgentPopover(false); }}
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
                更换工作区…
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <div className="titlebar-model-wrap" ref={agentRef}>
          <div
            className={`titlebar-model-badge${agentPopover ? " active" : ""}`}
            onClick={() => { setAgentPopover((value) => !value); setWsPopover(false); }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setAgentPopover((value) => !value); }}
          >
            <span className="titlebar-model-dot" />
            <span className="titlebar-model-text">{activeAgent?.name ?? "Agent"}</span>
            <span className="titlebar-model-sub">{displayModel}</span>
            <svg className="titlebar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {agentPopover && (
            <div className="titlebar-popover titlebar-popover-model">
              <div className="titlebar-popover-header">切换 Agent</div>
              {agents.length > 0 && (
                <div className="titlebar-popover-list">
                  {agents.map((agent) => {
                    const isActive = agent.id === activeAgent?.id;
                    return (
                      <button
                        key={agent.id}
                        className={`titlebar-popover-option${isActive ? " active" : ""}`}
                        onClick={() => {
                          if (!isActive) onSwitchAgent(agent.id);
                          setAgentPopover(false);
                        }}
                        type="button"
                      >
                        <div className={`titlebar-popover-option-dot${isActive ? " active" : ""}`} />
                        <div className="titlebar-popover-option-info">
                          <span className="titlebar-popover-option-name">{agent.name}</span>
                          <span className="titlebar-popover-option-model">{agent.description}</span>
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
              )}
              <div className="titlebar-popover-divider" />
              <div className="titlebar-popover-header" style={{ fontSize: "10px", opacity: 0.6, paddingTop: 4 }}>
                全局模型
              </div>
              {modelOptions.length > 0 && (
                <div className="titlebar-popover-list">
                  {modelOptions.map((option) => {
                    const isActive = option.modelId === activeModelId;
                    return (
                      <button
                        key={option.modelId}
                        className={`titlebar-popover-option${isActive ? " active" : ""}`}
                        onClick={() => {
                          if (!isActive) onSwitchModel(option.modelId);
                          setAgentPopover(false);
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
              )}
              <div className="titlebar-popover-divider" />
              <button
                className="titlebar-popover-action"
                onClick={() => { setAgentPopover(false); onToggleSettings(); }}
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
          className={`titlebar-btn${kitchenOpen ? " active" : ""}`}
          onClick={onToggleKitchen}
          type="button"
          title="控制台 (⌘J)"
        >
          <IconPanelBottom size={14} />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
