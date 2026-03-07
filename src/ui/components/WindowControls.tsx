import { type ReactElement } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Platform = "macos" | "windows" | "linux";

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "macos";
}

export function WindowControls(): ReactElement {
  const platform = detectPlatform();

  if (platform === "macos") return <></>;

  const win = getCurrentWindow();

  const runWindowAction = (label: string, action: () => Promise<void>) => {
    void action().catch((error) => {
      console.error(`[window-controls] Failed to ${label} window:`, error);
    });
  };

  return (
    <div className="window-controls">
      <button
        className="window-control-btn"
        onClick={() => runWindowAction("minimize", () => win.minimize())}
        aria-label="最小化"
        type="button"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        className="window-control-btn"
        onClick={() => runWindowAction("toggle maximize", () => win.toggleMaximize())}
        aria-label="最大化"
        type="button"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="1" y="1" width="8" height="8" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
      <button
        className="window-control-btn window-control-close"
        onClick={() => runWindowAction("close", () => win.close())}
        aria-label="关闭"
        type="button"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}
