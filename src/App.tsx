import { Suspense, type ReactElement, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AppSettings,
  getActiveVendor,
  loadSettings,
  loadVendorApiKey,
  saveSettings,
  saveVendorApiKey,
  setActiveManagedModelSelection,
  switchAgent,
  syncRuntimeSettings,
  updateWorkspacePath,
} from "./lib/settingsStore";
import { getAllChatAgents, getChatAgentFromSettings } from "./agents/builtinChatAgents";
import { ChatPage } from "./ui/pages/ChatPage";
import { TitleBar } from "./ui/components/TitleBar";
import { UpdateBanner } from "./ui/components/UpdateBanner";
import { useUpdater } from "./hooks/useUpdater";
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

const KitchenPage = lazy(() =>
  import("./ui/pages/KitchenPage").then((module) => ({ default: module.KitchenPage }))
);

const SettingsPage = lazy(() =>
  import("./ui/pages/SettingsPage").then((module) => ({ default: module.SettingsPage }))
);

function DeferredPaneFallback({ label }: { label: string }): ReactElement {
  return (
    <div className="page-content" style={{ padding: "20px 0" }}>
      <p className="status-note">{label}加载中…</p>
    </div>
  );
}

export default function App(): ReactElement {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [sessionState, setSessionState] = useState<SessionState>(initialSessionState);
  const updater = useUpdater();

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
      const apiKey = await loadVendorApiKey(getActiveVendor(settings)?.id);
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

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const handleSaveSettings = async (
    nextSettings: AppSettings,
    vendorApiKeys?: Record<string, string>
  ): Promise<void> => {
    const normalized = syncRuntimeSettings(nextSettings);
    const apiKeyEntries = Object.entries(vendorApiKeys ?? {});
    for (const [vendorId, apiKey] of apiKeyEntries) {
      await saveVendorApiKey(vendorId, apiKey);
    }
    const activeVendorId = getActiveVendor(normalized)?.id;
    const activeApiKey =
      (activeVendorId ? vendorApiKeys?.[activeVendorId] : undefined) ?? normalized.apiKey;
    saveSettings(normalized);
    setSettings({ ...normalized, apiKey: activeApiKey });
  };

  const handleSwitchModel = useCallback(async (modelId: string) => {
    let apiKey = "";
    const current = settingsRef.current;
    if (modelId === current.activeModelId) return;
    const switched = setActiveManagedModelSelection(current, modelId);
    try { apiKey = await loadVendorApiKey(getActiveVendor(switched)?.id); } catch { /* ignore */ }
    const next = { ...switched, apiKey };
    saveSettings(next);
    setSettings(next);
  }, []);

  const commitWorkspaceSelection = useCallback((workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    if (!normalizedPath) return;
    const next = updateWorkspacePath(settingsRef.current, normalizedPath);
    saveSettings(next);
    setSettings(next);
  }, []);

  const handleSelectWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string | null>("select_workspace_folder");
      if (!path) return;
      commitWorkspaceSelection(path);
    } catch { /* ignore */ }
  }, [commitWorkspaceSelection]);

  const handleSwitchWorkspace = useCallback((workspacePath: string) => {
    commitWorkspaceSelection(workspacePath);
  }, [commitWorkspaceSelection]);

  const handleSwitchAgent = useCallback((agentId: string) => {
    const current = settingsRef.current;
    if (agentId === current.activeAgentId) return;
    const next = switchAgent(current, agentId);
    saveSettings(next);
    setSettings(next);
  }, []);

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
          recentWorkspaces={settings.recentWorkspaces}
          gitBranch={gitBranch}
          currentModel={settings.model}
          modelOptions={settings.managedModels.map((managedModel) => ({
            vendorId: managedModel.vendorId,
            modelId: managedModel.id,
            vendorName: settings.vendors.find((vendor) => vendor.id === managedModel.vendorId)?.name ?? "未知供应商",
            modelName: managedModel.name,
          }))}
          activeModelId={settings.activeModelId}
          agents={getAllChatAgents(settings)}
          activeAgentId={settings.activeAgentId}
          onToggleKitchen={() => setKitchenOpen((v) => !v)}
          onToggleSettings={() => setSettingsOpen((v) => !v)}
          onSwitchModel={(id) => void handleSwitchModel(id)}
          onSwitchAgent={handleSwitchAgent}
          onSelectWorkspace={() => void handleSelectWorkspace()}
          onSwitchWorkspace={handleSwitchWorkspace}
          kitchenOpen={kitchenOpen}
        />

        <div className="app-body">
          <ChatPage
            settings={settings}
            activeAgent={getChatAgentFromSettings(settings.activeAgentId, settings)}
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
            <Suspense fallback={<DeferredPaneFallback label="控制台" />}>
              <KitchenPage />
            </Suspense>
          </div>
        )}

        {settingsOpen && (
          <div className="settings-modal-backdrop">
            <div className="settings-modal">
              <Suspense fallback={<DeferredPaneFallback label="设置" />}>
                <SettingsPage
                  settings={settings}
                  onSave={handleSaveSettings}
                  onClose={() => setSettingsOpen(false)}
                />
              </Suspense>
            </div>
          </div>
        )}

        <UpdateBanner
          {...updater}
          onInstall={updater.installUpdate}
          onDismiss={updater.dismiss}
        />
      </div>
    </SessionContext.Provider>
  );
}
