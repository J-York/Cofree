import { type ReactElement, useEffect, useMemo, useState } from "react";
import { defaultModelForProvider, formatModelRef } from "./lib/litellm";
import {
  type AppSettings,
  loadSecureApiKey,
  loadSettings,
  saveSecureApiKey,
  saveSettings
} from "./lib/settingsStore";
import { type AppTab } from "./ui/components/NavTabs";
import { ChatPage } from "./ui/pages/ChatPage";
import { KitchenPage } from "./ui/pages/KitchenPage";
import { SettingsPage } from "./ui/pages/SettingsPage";

const NAV_ITEMS: Array<{ key: AppTab; icon: string; label: string }> = [
  { key: "chat",     icon: "💬", label: "聊天" },
  { key: "kitchen",  icon: "🍳", label: "厨房" },
  { key: "settings", icon: "⚙️", label: "设置" },
];

export default function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<AppTab>("chat");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  const runtimeSummary = useMemo(() => {
    if (!settings.allowCloudModels) return "Local-only";
    return formatModelRef(settings.provider, settings.model);
  }, [settings.allowCloudModels, settings.model, settings.provider]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const apiKey = await loadSecureApiKey();
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
      nextSettings.model.trim() || defaultModelForProvider(nextSettings.provider);
    const normalized: AppSettings = { ...nextSettings, model: normalizedModel };
    await saveSecureApiKey(normalized.apiKey);
    saveSettings(normalized);
    setSettings(normalized);
  };

  return (
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

          <div className="sidebar-footer">
            <div className="runtime-badge">
              <div className="runtime-dot" />
              <span className="runtime-text">{runtimeSummary}</span>
            </div>
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
  );
}
