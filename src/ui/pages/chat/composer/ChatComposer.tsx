import { useEffect, type ReactElement, type RefObject } from "react";
import type { ChatContextAttachment } from "../../../../lib/contextAttachments";
import type { SkillEntry } from "../../../../lib/skillStore";
import type { SnippetEntry } from "../../../../lib/snippetStore";
import { IconTrash } from "../../../components/Icons";
import { ContextAttachmentPills, TokenUsageRing } from "../ChatPresentational";
import type { ActiveMention, MentionSuggestion } from "../mentions";

export interface ChatComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  chatBlocked: boolean;
  composerAttachments: ChatContextAttachment[];
  onRemoveComposerAttachment: (attachmentId: string) => void;
  selectedSkills: SkillEntry[];
  onRemoveSelectedSkill: (skillId: string) => void;
  selectedSnippets: SnippetEntry[];
  onRemoveSelectedSnippet: (snippetId: string) => void;
  activeMention: ActiveMention | null;
  mentionSuggestions: MentionSuggestion[];
  mentionSelectionIndex: number;
  onPromptChange: (nextText: string, caretIndex?: number) => void;
  onMentionSync: (nextText: string, caretIndex?: number) => void;
  onMentionSuggestionSelect: (suggestion: MentionSuggestion) => void;
  onSelectNextMention: (maxIndex: number) => void;
  onSelectPreviousMention: () => void;
  onClearMentionUi: () => void;
  onSubmit: () => void | Promise<void>;
  liveContextTokens: number | null;
  maxContextTokens: number;
  isStreaming: boolean;
  executingActionId: string;
  messagesCount: number;
  onClearHistory: () => void;
  debugMode: boolean;
  isExportingDebugBundle: boolean;
  hasDebugBundleTarget: boolean;
  onDownloadConversationDebugBundle: () => void;
  onCancel: () => void;
  /** When set, the composer renders in "edit mode": shows a hint banner and a
   * cancel-edit button, swaps the submit label, and routes submission through
   * onSubmit just like new messages — the parent decides what onSubmit does
   * based on whether editingMessageId is set. */
  editingMessageId?: string | null;
  onCancelEdit?: () => void;
}

export function ChatComposer({
  textareaRef,
  prompt,
  chatBlocked,
  composerAttachments,
  onRemoveComposerAttachment,
  selectedSkills,
  onRemoveSelectedSkill,
  selectedSnippets,
  onRemoveSelectedSnippet,
  activeMention,
  mentionSuggestions,
  mentionSelectionIndex,
  onPromptChange,
  onMentionSync,
  onMentionSuggestionSelect,
  onSelectNextMention,
  onSelectPreviousMention,
  onClearMentionUi,
  onSubmit,
  liveContextTokens,
  maxContextTokens,
  isStreaming,
  executingActionId,
  messagesCount,
  onClearHistory,
  debugMode,
  isExportingDebugBundle,
  hasDebugBundleTarget,
  onDownloadConversationDebugBundle,
  onCancel,
  editingMessageId,
  onCancelEdit,
}: ChatComposerProps): ReactElement {
  const isEditing = Boolean(editingMessageId);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [prompt, textareaRef]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <div className={`chat-input-box${isEditing ? " chat-input-box-editing" : ""}`}>
        {isEditing && (
          <div className="chat-edit-banner" role="status">
            <span className="chat-edit-banner-icon" aria-hidden>✎</span>
            <span className="chat-edit-banner-label">
              正在编辑历史消息 · 提交后将截断后续历史并重新生成
            </span>
            {onCancelEdit && (
              <button
                type="button"
                className="chat-edit-banner-cancel"
                onClick={onCancelEdit}
                aria-label="取消编辑"
              >
                取消
              </button>
            )}
          </div>
        )}
        <ContextAttachmentPills
          attachments={composerAttachments}
          onRemove={onRemoveComposerAttachment}
        />
        {(selectedSkills.length > 0 || selectedSnippets.length > 0) && (
          <div className="chat-context-pills">
            {selectedSkills.map((skill) => (
              <span key={skill.id} className="chat-skill-pill">
                <span className="chat-skill-pill-prefix">✦</span>
                <span className="chat-skill-pill-label" title={skill.description}>{skill.name}</span>
                <button
                  type="button"
                  className="chat-context-pill-remove"
                  onClick={() => onRemoveSelectedSkill(skill.id)}
                  aria-label={`移除 ${skill.name}`}
                  title={`移除 ${skill.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {selectedSnippets.map((snippet) => (
              <span key={snippet.id} className="chat-snippet-pill">
                <span className="chat-snippet-pill-prefix">📑</span>
                <span className="chat-snippet-pill-label" title={snippet.description}>{snippet.name}</span>
                <button
                  type="button"
                  className="chat-context-pill-remove"
                  onClick={() => onRemoveSelectedSnippet(snippet.id)}
                  aria-label={`移除 ${snippet.name}`}
                  title={`移除 ${snippet.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {activeMention && mentionSuggestions.length > 0 && (
          <div className="chat-mention-menu" role="listbox" aria-label="@ 候选">
            {mentionSuggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.kind}:${suggestion.relativePath}`}
                type="button"
                className={`chat-mention-item${index === mentionSelectionIndex ? " active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onMentionSuggestionSelect(suggestion);
                }}
              >
                <span className="chat-mention-item-name">
                  {suggestion.kind === "skill"
                    ? "✦ "
                    : suggestion.kind === "snippet"
                      ? "📑 "
                      : ""}
                  {suggestion.displayName}
                  {suggestion.kind === "folder" ? "/" : ""}
                </span>
                <span className="chat-mention-item-path">
                  {suggestion.kind === "skill"
                    ? `Skill · ${suggestion.description ?? ""}`
                    : suggestion.kind === "snippet"
                      ? `知识 · ${suggestion.description ?? ""}`
                      : `${suggestion.kind === "folder" ? "目录" : "文件"} · ${suggestion.relativePath}${suggestion.kind === "folder" ? "/" : ""}`
                  }
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          value={prompt}
          disabled={chatBlocked}
          onChange={(event) =>
            onPromptChange(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            )
          }
          onKeyDown={(event) => {
            if (activeMention && mentionSuggestions.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                onSelectNextMention(mentionSuggestions.length - 1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                onSelectPreviousMention();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClearMentionUi();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onMentionSuggestionSelect(
                  mentionSuggestions[mentionSelectionIndex] ?? mentionSuggestions[0],
                );
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSubmit();
            }
          }}
          onClick={(event) =>
            onMentionSync(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? event.currentTarget.value.length,
            )
          }
          onKeyUp={(event) => {
            if (
              activeMention &&
              mentionSuggestions.length > 0 &&
              (event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                event.key === "Escape" ||
                (event.key === "Enter" && !event.shiftKey))
            ) {
              return;
            }
            onMentionSync(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? event.currentTarget.value.length,
            );
          }}
          placeholder={chatBlocked ? "请先完成设置…" : "描述你的编码任务…"}
          rows={1}
        />
        <div className="chat-input-footer">
          <div className="chat-input-meta">
            {liveContextTokens !== null && (
              <TokenUsageRing
                used={liveContextTokens}
                max={maxContextTokens}
                isStreaming={isStreaming}
              />
            )}
            <button
              className="btn btn-ghost"
              style={{
                padding: "4px",
                height: "22px",
                width: "22px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              disabled={isStreaming || Boolean(executingActionId) || messagesCount === 0}
              onClick={onClearHistory}
              type="button"
              title="清空当前对话"
            >
              <IconTrash size={14} />
            </button>
          </div>
          <div className="chat-input-actions">
            {!chatBlocked && !isStreaming && (
              <span className="chat-shortcut-hint" aria-hidden>
                ⏎ 发送 · ⇧⏎ 换行 · @ 文件
              </span>
            )}
            {debugMode && (
              <button
                className="btn btn-ghost btn-sm"
                disabled={isExportingDebugBundle || !hasDebugBundleTarget}
                onClick={onDownloadConversationDebugBundle}
                type="button"
              >
                {isExportingDebugBundle ? "导出中…" : "下载日志"}
              </button>
            )}
            {isStreaming && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={onCancel}
                type="button"
              >
                停止
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              disabled={
                isStreaming ||
                Boolean(executingActionId) ||
                (!prompt.trim() &&
                  composerAttachments.length === 0 &&
                  selectedSkills.length === 0 &&
                  selectedSnippets.length === 0) ||
                chatBlocked
              }
              type="submit"
            >
              {isEditing ? "保存并重新生成" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
