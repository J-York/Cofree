import type { ReactNode } from "react";

import type {
  ConversationTopbarAttention,
  ConversationTopbarBadge,
  ConversationTopbarState,
} from "./conversationTopbarState";

export type ConversationTopbarAction =
  | NonNullable<ConversationTopbarBadge["action"]>
  | NonNullable<ConversationTopbarAttention["ctaAction"]>
  | "progress";

export type ConversationTopbarProps = {
  state: ConversationTopbarState;
  onAction?: (action: ConversationTopbarAction) => void;
};

function attentionLevelPrefix(level: ConversationTopbarAttention["level"]): string {
  switch (level) {
    case "warning":
      return "警告";
    case "blocked":
      return "阻塞";
    default:
      return "提示";
  }
}

function segmentLabel(seg: NonNullable<ConversationTopbarState["progress"]["segments"]>[number]): string {
  switch (seg) {
    case "completed":
      return "已完成";
    case "active":
      return "进行中";
    case "blocked":
      return "阻塞";
    default:
      return "待处理";
  }
}

function badgeToneClass(tone: ConversationTopbarBadge["tone"] | undefined): string {
  if (!tone || tone === "default") return "";
  return ` conversation-topbar-badge--${tone}`;
}

/** Stable accessible name for the progress row control (not derived from visual label text). */
const PROGRESS_ROW_ARIA_LABEL = "查看进度，跳转至进度详情";

export function ConversationTopbar({ state, onAction }: ConversationTopbarProps): ReactNode {
  const { agentLabel, primaryLabel, badges, progress, attention } = state;
  const progressDisabled = progress.disabled === true;

  return (
    <div className="conversation-topbar">
      <div className="conversation-topbar-row" data-conversation-topbar-row="1">
        <span className="conversation-topbar-agent">{agentLabel}</span>
        <div className="conversation-topbar-primary" aria-live="polite">
          {primaryLabel}
        </div>
        <div className="conversation-topbar-badges" role="list">
          {badges.map((badge) => {
            const className = `conversation-topbar-badge${badgeToneClass(badge.tone)}`;
            if (badge.action) {
              return (
                <button
                  key={badge.key}
                  type="button"
                  className={className}
                  role="listitem"
                  disabled={badge.disabled === true}
                  onClick={() => {
                    if (!badge.disabled) {
                      onAction?.(badge.action!);
                    }
                  }}
                >
                  {badge.label}
                </button>
              );
            }
            return (
              <span key={badge.key} className={className} role="listitem">
                {badge.label}
              </span>
            );
          })}
        </div>
      </div>

      {progress.visible ? (
        <div
          className="conversation-topbar-row conversation-topbar-progress"
          role="button"
          tabIndex={progressDisabled ? -1 : 0}
          aria-label={PROGRESS_ROW_ARIA_LABEL}
          aria-disabled={progressDisabled}
          onClick={() => {
            if (!progressDisabled) {
              onAction?.("progress");
            }
          }}
          onKeyDown={(e) => {
            if (progressDisabled) {
              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onAction?.("progress");
            }
          }}
        >
          {progress.label != null && progress.label !== "" ? (
            <span className="conversation-topbar-progress-label">{progress.label}</span>
          ) : null}
          {progress.segments && progress.segments.length > 0 ? (
            <div
              className="conversation-topbar-track"
              role="presentation"
              onClick={(e) => {
                if (progressDisabled) {
                  return;
                }
                e?.stopPropagation?.();
                onAction?.("progress");
              }}
            >
              {progress.segments.map((seg, i) => (
                <span
                  key={`${seg}-${i}`}
                  className={`conversation-topbar-segment conversation-topbar-segment--${seg}`}
                  data-conversation-topbar-segment={seg}
                  title={segmentLabel(seg)}
                >
                  <span className="conversation-topbar-segment-label">{segmentLabel(seg)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {attention !== null ? (
        <div className="conversation-topbar-row conversation-topbar-attention" data-attention-level={attention.level}>
          <div className="conversation-topbar-attention-live" aria-live="polite">
            <span className="conversation-topbar-attention-level">{attentionLevelPrefix(attention.level)}</span>{" "}
            <span className="conversation-topbar-attention-message">{attention.message}</span>
            {typeof attention.extraCount === "number" && attention.extraCount > 0 ? (
              <span className="conversation-topbar-attention-extra"> +{attention.extraCount}</span>
            ) : null}
          </div>
          {attention.ctaLabel && attention.ctaAction ? (
            <button
              type="button"
              className="conversation-topbar-cta"
              disabled={attention.ctaDisabled === true}
              onClick={() => {
                if (!attention.ctaDisabled) {
                  onAction?.(attention.ctaAction!);
                }
              }}
            >
              {attention.ctaLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
