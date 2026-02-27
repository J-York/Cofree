/**
 * Cofree - AI Programming Cafe
 * File: src/ui/components/NavTabs.tsx
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Primary navigation tabs for Chat/Kitchen/Settings.
 */

import type { ReactElement } from "react";

export type AppTab = "chat" | "kitchen" | "settings";

const TAB_ITEMS: Array<{ key: AppTab; label: string }> = [
  { key: "chat", label: "聊天区" },
  { key: "kitchen", label: "厨房" },
  { key: "settings", label: "设置" }
];

interface NavTabsProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
}

export function NavTabs({ activeTab, onTabChange }: NavTabsProps): ReactElement {
  return (
    <nav aria-label="Primary" className="tab-nav">
      {TAB_ITEMS.map((tab) => (
        <button
          key={tab.key}
          aria-selected={activeTab === tab.key}
          className="tab-button"
          onClick={() => onTabChange(tab.key)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
