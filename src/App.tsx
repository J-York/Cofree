import { type ReactElement, useEffect, useMemo, useState } from "react";
import { defaultModelForProvider } from "./lib/litellm";
import {
  type AppSettings,
  loadSecureApiKey,
  loadSettings,
  saveSecureApiKey,
  saveSettings,
} from "./lib/settingsStore";
import { ChatPage } from "./ui/pages/ChatPage";
import { KitchenPage } from "./ui/pages/KitchenPage";
import { SettingsPage } from "./ui/pages/SettingsPage";
import { TitleBar } from "./ui/components/TitleBar";
import {
  SessionContext,
  initialSessionState,
  type SessionState,
  type SessionActions,
} from "./lib/sessionContext";
import { invoke } from "@tauri-apps/api/core";

interface WorkspaceInfo {
  git_branch?: string;
}

export default function App(): ReactElement {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [sessionState, setSessionState] = useState<SessionState>(initialSessionState);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [kitchenOpen, setKitchenOpen] = useState(false);
  const [gitBranch, setGitBranch] = useState<string>("");

  const sessionActions: SessionActions = useMemo(
    () => ({
      updatePlan: (plan) =>
        setSessionState((s) => ({ ...s, currentPlan: plan })),
      appendToolTraces: (traces) =>
        setSessionState((s) => ({
          ...s,
          toolTraces: [...s.toolTraces, ...traces],
        })),
      appendRequestSummary: (summary) =>
        setSessionState((s) => ({
          ...s,
          requestSummaries: [...s.requestSummaries, summary],
        })),
      setWorkflowPhase: (phase) =>
        setSessionState((s) => ({ ...s, workflowPhase: phase })),
      resetSession: () => setSessionState(initialSessionState),
    }),
    []
  );

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const apiKey = await loadSecureApiKey(settings.activeProfileId);
      if (cancelled) return;
      setSettings((current) => (current.apiKey === apiKey ? current : { ...current, apiKey }));
    };
    void hydrate();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settings.workspacePath) { setGitBranch(""); return; }
    let cancelled = false;
    invoke<WorkspaceInfo>("get_workspace_info", { path: settings.workspacePath })
      .then((info) => { if (!cancelled) setGitBranch(info.git_branch ?? ""); })
      .catch(() => { if (!cancelled) setGitBranch(""); });
    return () => { cancelled = true; };
  }, [settings.workspacePath]);

  const handleSaveSettings = async (nextSettings: AppSettings): Promise<void> => {
    const normalizedModel =
      nextSettings.model.trim() || defaultModelForProvider(nextSettings.provider ?? "openai");
    const normalized: AppSettings = { ...nextSettings, model: normalizedModel };
    await saveSecureApiKey(normalized.apiKey, normalized.activeProfileId);
    saveSettings(normalized);
    setSettings(normalized);
  };

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      switch (e.key) {
        case "b":
          e.preventDefault();
          setSidebarCollapsed((v) => !v);
          break;
        case ",":
          e.preventDefault();
          setSettingsOpen((v) => !v);
          break;
        case "j":
          e.preventDefault();
          setKitchenOpen((v) => !v);
          break;
        case "n":
          e.preventDefault();
          // Dispatch a custom event that ChatPage listens to
          window.dispatchEvent(new CustomEvent("cofree:new-conversation"));
          break;
      }

      if (e.key === "Escape") {
        if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); }
        else if (kitchenOpen) { setKitchenOpen(false); e.preventDefault(); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [settingsOpen, kitchenOpen]);

  return (
    <SessionContext.Provider value={{ state: sessionState, actions: sessionActions }}>
      <div className="app-shell">
        <TitleBar
          workspacePath={settings.workspacePath}
          gitBranch={gitBranch}
          currentModel={settings.model || defaultModelForProvider(settings.provider ?? "openai")}
          onToggleKitchen={() => setKitchenOpen((v) => !v)}
          onToggleSettings={() => setSettingsOpen((v) => !v)}
          kitchenOpen={kitchenOpen}
        />

        <div className="app-body">
          <ChatPage
            settings={settings}
            isVisible={true}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          />
        </div>

        {kitchenOpen && (
          <div className="kitchen-panel-container">
            <div className="kitchen-panel-header">
              <span className="kitchen-panel-title">控制台</span>
              <button
                className="kitchen-panel-close"
                onClick={() => setKitchenOpen(false)}
                type="button"
              >
                &times;
              </button>
            </div>
            <KitchenPage />
          </div>
        )}

        {settingsOpen && (
          <div className="settings-modal-backdrop" onClick={() => setSettingsOpen(false)}>
            <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
              <SettingsPage settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />
            </div>
          </div>
        )}
      </div>
    </SessionContext.Provider>
  );
}
