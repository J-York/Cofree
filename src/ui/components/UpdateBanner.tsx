import type { ReactElement } from "react";
import type { UpdateErrorAction, UpdateState } from "../../hooks/useUpdater";

interface Props extends UpdateState {
  visible: boolean;
  onInstall: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

function getErrorSummary(version: string, errorAction: UpdateErrorAction): string {
  if (!version || errorAction === "check") {
    return "自动更新检查失败";
  }

  return `v${version} 更新失败`;
}

function getRetryLabel(errorAction: UpdateErrorAction): string {
  if (errorAction === "install") {
    return "重试更新";
  }

  if (errorAction === "check") {
    return "重新检查";
  }

  return "重试";
}

export function UpdateBanner({
  visible,
  status,
  version,
  progress,
  error,
  errorAction,
  onInstall,
  onRetry,
  onDismiss,
}: Props): ReactElement | null {
  if (!visible) return null;

  return (
    <div className="update-banner">
      <div className="update-banner-content">
        {status === "available" && (
          <>
            <span className="update-banner-icon">✦</span>
            <span className="update-banner-text">
              新版本 <strong>v{version}</strong> 已发布
            </span>
            <button
              type="button"
              className="btn btn-xs btn-primary update-banner-action"
              onClick={onInstall}
            >
              立即更新
            </button>
            <button
              type="button"
              className="update-banner-dismiss"
              onClick={onDismiss}
              title="稍后再说"
            >
              ✕
            </button>
          </>
        )}

        {status === "downloading" && (
          <>
            <span className="update-banner-icon spinning">↻</span>
            <span className="update-banner-text">
              正在下载 v{version}…{progress > 0 ? ` ${progress}%` : ""}
            </span>
            <div className="update-banner-progress">
              <div
                className="update-banner-progress-bar"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}

        {status === "installing" && (
          <>
            <span className="update-banner-icon spinning">↻</span>
            <span className="update-banner-text">正在安装，即将重启…</span>
          </>
        )}

        {status === "error" && (
          <>
            <span className="update-banner-icon">⚠</span>
            <span className="update-banner-text">
              {getErrorSummary(version, errorAction)}：{error || "未知错误"}
            </span>
            <button
              type="button"
              className="btn btn-xs btn-primary update-banner-action"
              onClick={onRetry}
            >
              {getRetryLabel(errorAction)}
            </button>
            <button
              type="button"
              className="update-banner-dismiss"
              onClick={onDismiss}
              title="关闭提示"
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}
