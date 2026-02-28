/**
 * Cofree - AI Programming Cafe
 * File: src/App.tsx
 * Milestone: 2
 * Task: 2.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: App shell with milestone-3 wiring for HITL approvals and guarded actions.
 */

import { type ReactElement, useMemo, useState } from "react";
import { defaultModelForProvider, formatModelRef } from "./lib/litellm";
import { type AppSettings, loadSettings, saveSettings } from "./lib/settingsStore";
import { NavTabs, type AppTab } from "./ui/components/NavTabs";
import { ChatPage } from "./ui/pages/ChatPage";
import { KitchenPage } from "./ui/pages/KitchenPage";
import { SettingsPage } from "./ui/pages/SettingsPage";

export default function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<AppTab>("chat");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  const runtimeSummary = useMemo(() => {
    if (!settings.allowCloudModels) {
      return "Local-only mode";
    }

    return formatModelRef(settings.provider, settings.model);
  }, [settings.allowCloudModels, settings.model, settings.provider]);

  const handleSaveSettings = (nextSettings: AppSettings): void => {
    const normalizedModel =
      nextSettings.model.trim() || defaultModelForProvider(nextSettings.provider);
    const normalizedSettings: AppSettings = {
      ...nextSettings,
      model: normalizedModel
    };

    saveSettings(normalizedSettings);
    setSettings(normalizedSettings);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="kicker">Milestone 3</p>
          <h1>Cofree</h1>
        </div>
        <p className="runtime-pill">Active Runtime: {runtimeSummary}</p>
      </header>

      <NavTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <section className="app-panel">
        {activeTab === "chat" ? <ChatPage settings={settings} /> : null}
        {activeTab === "kitchen" ? <KitchenPage /> : null}
        {activeTab === "settings" ? (
          <SettingsPage settings={settings} onSave={handleSaveSettings} />
        ) : null}
      </section>
    </main>
  );
}
