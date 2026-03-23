import { type ReactElement, useState } from "react";
import type { CategorizedError } from "../../lib/errorClassifier";
import {
  IconAlertTriangle,
  IconLightning,
  IconShield,
  IconFolderAlert,
  IconRobot,
  IconUnknown,
  IconX
} from "./Icons";

interface ErrorBannerProps {
  error: CategorizedError;
  onRetry?: () => void;
  onDismiss?: () => void;
  onCopyDebugLog?: () => void;
  copyDebugLogLabel?: string;
}

export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
  onCopyDebugLog,
  copyDebugLogLabel,
}: ErrorBannerProps): ReactElement {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className={`error-banner error-banner-${error.category}`}>
      <div className="error-banner-header">
        <div className="error-banner-title-row">
          <span className="error-banner-icon">
            {error.category === "auth_error" && <IconShield />}
            {error.category === "network_timeout" && <IconLightning />}
            {error.category === "patch_conflict" && <IconAlertTriangle />}
            {error.category === "workspace_error" && <IconFolderAlert />}
            {error.category === "llm_failure" && <IconRobot />}
            {error.category === "unknown" && <IconUnknown />}
          </span>
          <span className="error-banner-title">{error.title}</span>
        </div>
        {onDismiss && (
          <button
            className="error-banner-dismiss"
            onClick={onDismiss}
            type="button"
            aria-label="dismiss"
          >
            <IconX size={14} />
          </button>
        )}
      </div>
      <p className="error-banner-message">{error.message}</p>
      {error.guidance && (
        <p className="error-banner-guidance">{error.guidance}</p>
      )}
      <div className="error-banner-actions">
        {error.retriable && onRetry && (
          <button className="btn btn-ghost btn-sm" onClick={onRetry} type="button">
            重试
          </button>
        )}
        {error.rawError && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowRaw(!showRaw)}
            type="button"
          >
            {showRaw ? "隐藏详情" : "查看详情"}
          </button>
        )}
        {onCopyDebugLog && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onCopyDebugLog}
            type="button"
          >
            {copyDebugLogLabel || "复制请求日志"}
          </button>
        )}
      </div>
      {showRaw && error.rawError && (
        <pre className="error-banner-raw">{error.rawError}</pre>
      )}
    </div>
  );
}
