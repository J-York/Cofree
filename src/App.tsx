import { Suspense, type ReactElement, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AppSettings,
  getActiveVendor,
  loadSettings,
  loadVendorApiKey,
  saveSettings,
  saveVendorApiKey,
  setActiveManagedModelSelection,
  syncRuntimeSettings,
  updateWorkspacePath,
} from "./lib/settingsStore";
import { DEFAULT_CHAT_AGENT } from "./agents/builtinChatAgents";
import { ChatPage } from "./ui/pages/ChatPage";
import { TitleBar } from "./ui/components/TitleBar";
import { UpdateBanner } from "./ui/components/UpdateBanner";
import { openSystemTerminal } from "./lib/tauriBridge";
import { useUpdater } from "./hooks/useUpdater";
import { useTheme } from "./hooks/useTheme";
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
  
  // Initialize theme system
  useTheme();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const handleOpenSystemTerminal = useCallback(() => {
    const workspacePath = settingsRef.current.workspacePath;
    if (!workspacePath) return;
    void openSystemTerminal(workspacePath).catch((err) => {
      console.error("open_system_terminal failed", err);
    });
  }, []);

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); }
        return;
      }

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
          handleOpenSystemTerminal();
          break;
        case "n":
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("cofree:new-conversation"));
          break;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [settingsOpen, handleOpenSystemTerminal]);

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
          onOpenSystemTerminal={handleOpenSystemTerminal}
          onToggleSettings={() => setSettingsOpen((v) => !v)}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          sidebarCollapsed={sidebarCollapsed}
          onSwitchModel={(id) => void handleSwitchModel(id)}
          onSelectWorkspace={() => void handleSelectWorkspace()}
          onSwitchWorkspace={handleSwitchWorkspace}
        />

        <div className="app-body">
          {settingsOpen ? (
            <Suspense fallback={<DeferredPaneFallback label="设置" />}>
              <SettingsPage
                settings={settings}
                onSave={handleSaveSettings}
                onClose={() => setSettingsOpen(false)}
              />
            </Suspense>
          ) : (
            <ChatPage
              settings={settings}
              activeAgent={DEFAULT_CHAT_AGENT}
              isVisible={true}
              sidebarCollapsed={sidebarCollapsed}
            />
          )}
        </div>

        <UpdateBanner
          {...updater}
          onInstall={updater.installUpdate}
          onRetry={updater.retry}
          onDismiss={updater.dismiss}
        />
      </div>
    </SessionContext.Provider>
  );
}
