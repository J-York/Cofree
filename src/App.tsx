import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultModelForProvider, formatModelRef } from "./lib/litellm";
import {
  type AppSettings,
  getActiveProfile,
  loadSecureApiKey,
  loadSettings,
  saveSecureApiKey,
  saveSettings,
  switchProfile,
} from "./lib/settingsStore";
import { type AppTab } from "./ui/components/NavTabs";
import { ChatPage } from "./ui/pages/ChatPage";
import { KitchenPage } from "./ui/pages/KitchenPage";
import { SettingsPage } from "./ui/pages/SettingsPage";
import {
  SessionContext,
  initialSessionState,
  type SessionState,
  type SessionActions,
} from "./lib/sessionContext";

const NAV_ITEMS: Array<{ key: AppTab; icon: string; label: string }> = [
  { key: "chat",     icon: "💬", label: "聊天" },
  { key: "kitchen",  icon: "🍳", label: "厨房" },
  { key: "settings", icon: "⚙️", label: "设置" },
];

export default function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<AppTab>("chat");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [sessionState, setSessionState] = useState<SessionState>(initialSessionState);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

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

  const runtimeSummary = useMemo(() => {
    if (!settings.allowCloudModels) return "Local-only";
    return formatModelRef(settings.provider ?? "", settings.model);
  }, [settings.allowCloudModels, settings.model, settings.provider]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const apiKey = await loadSecureApiKey(settings.activeProfileId);
      if (cancelled) {
        return;
      }
      setSettings((current) => (current.apiKey === apiKey ? current : { ...current, apiKey }));
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveSettings = async (nextSettings: AppSettings): Promise<void> => {
    const normalizedModel =
      nextSettings.model.trim() || defaultModelForProvider(nextSettings.provider ?? "openai");
    const normalized: AppSettings = { ...nextSettings, model: normalizedModel };
    await saveSecureApiKey(normalized.apiKey, normalized.activeProfileId);
    saveSettings(normalized);
    setSettings(normalized);
  };

  const handleQuickSwitchProfile = useCallback(async (profileId: string) => {
    if (profileId === settings.activeProfileId) {
      setProfileMenuOpen(false);
      return;
    }
    const switched = switchProfile(settings, profileId);
    let apiKey = "";
    try {
      apiKey = await loadSecureApiKey(profileId);
    } catch {
      // Ignore keychain errors
    }
    const updated: AppSettings = { ...switched, apiKey };
    saveSettings(updated);
    setSettings(updated);
    setProfileMenuOpen(false);
  }, [settings]);

  // Close profile menu on outside click
  useEffect(() => {
    if (!profileMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [profileMenuOpen]);

  const activeProfile = getActiveProfile(settings);
  const hasProfiles = settings.profiles.length > 0;

  return (
    <SessionContext.Provider value={{ state: sessionState, actions: sessionActions }}>
    <div className="app-shell">
      <div className="app-layout">
        {/* ── Sidebar ── */}
        <aside className="app-sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <div className="sidebar-logo-icon">☕</div>
              <span className="sidebar-logo-text">Cofree</span>
            </div>
            <p className="sidebar-tagline">AI Programming Café</p>
          </div>

          <nav className="sidebar-nav" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                className={`sidebar-nav-item${activeTab === item.key ? " active" : ""}`}
                onClick={() => setActiveTab(item.key)}
                type="button"
                aria-current={activeTab === item.key ? "page" : undefined}
              >
                <span className="sidebar-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer" ref={profileMenuRef}>
            <button
              className="runtime-badge"
              type="button"
              onClick={() => hasProfiles && setProfileMenuOpen((v) => !v)}
              style={{ cursor: hasProfiles ? "pointer" : "default", width: "100%", border: "1px solid var(--border-1)" }}
              title={hasProfiles ? "切换配置档案" : runtimeSummary}
            >
              <div className="runtime-dot" />
              <span className="runtime-text" style={{ flex: 1, textAlign: "left" }}>
                {activeProfile ? activeProfile.name : runtimeSummary}
              </span>
              {hasProfiles && (
                <span className="runtime-text" style={{ flexShrink: 0, fontSize: "9px", opacity: 0.6 }}>
                  {profileMenuOpen ? "▲" : "▼"}
                </span>
              )}
            </button>
            {activeProfile && (
              <div className="runtime-model-hint">
                {runtimeSummary}
              </div>
            )}

            {profileMenuOpen && hasProfiles && (
              <div className="profile-switcher-menu">
                <div className="profile-switcher-header">切换配置</div>
                {settings.profiles.map((p) => (
                  <button
                    key={p.id}
                    className={`profile-switcher-item${p.id === settings.activeProfileId ? " active" : ""}`}
                    type="button"
                    onClick={() => void handleQuickSwitchProfile(p.id)}
                  >
                    <div className={`profile-switcher-dot${p.id === settings.activeProfileId ? " active" : ""}`} />
                    <div className="profile-switcher-info">
                      <span className="profile-switcher-name">{p.name}</span>
                      <span className="profile-switcher-model">
                        {formatModelRef(p.provider ?? "", p.model)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="app-main">
          {activeTab === "chat"     && <ChatPage settings={settings} />}
          {activeTab === "kitchen"  && <KitchenPage />}
          {activeTab === "settings" && (
            <SettingsPage settings={settings} onSave={handleSaveSettings} />
          )}
        </main>
      </div>
    </div>
    </SessionContext.Provider>
  );
}
