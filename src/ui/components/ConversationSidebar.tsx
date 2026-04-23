/**
 * Cofree — Permanent conversation list panel (left sidebar).
 */

import { type ReactElement, useState } from "react";
import type { ConversationMetadata } from "../../lib/conversationStore";
import { IconPlus, IconEdit, IconTrash, IconCheck, IconX } from "./Icons";

interface ConversationSidebarProps {
  conversations: ConversationMetadata[];
  activeConversationId: string | null;
  collapsed: boolean;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, newTitle: string) => void;
}

export function ConversationSidebar({
  conversations,
  activeConversationId,
  collapsed,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
}: ConversationSidebarProps): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  if (collapsed) {
    return <div className="conv-panel collapsed" />;
  }

  const handleStartEdit = (conv: ConversationMetadata) => {
    setEditingId(conv.id);
    setEditingTitle(conv.title);
  };

  const handleSaveEdit = (id: string) => {
    if (editingTitle.trim()) onRenameConversation(id, editingTitle.trim());
    setEditingId(null);
    setEditingTitle("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const handleConfirmDelete = (id: string) => {
    setConfirmingDeleteId(null);
    onDeleteConversation(id);
  };

  const formatDate = (dateString: string): string => {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffMins < 1) return "刚刚";
      if (diffMins < 60) return `${diffMins}分钟前`;
      if (diffHours < 24) return `${diffHours}小时前`;
      if (diffDays < 7) return `${diffDays}天前`;
      return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  };

  return (
    <aside className="conv-panel">
      <div className="conv-panel-header">
        <button
          className="conv-panel-new-btn"
          onClick={onNewConversation}
          type="button"
          title="新建对话 (⌘N)"
        >
          <IconPlus size={14} />
          <span className="conv-panel-new-label">新对话</span>
        </button>
      </div>

      <div className="conv-panel-list">
        {conversations.length === 0 ? (
          <div className="conv-panel-empty">
            <p>暂无对话</p>
            <p className="conv-panel-empty-hint">⌘N 新建</p>
          </div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`conv-panel-item${activeConversationId === conv.id ? " active" : ""}`}
            >
              {editingId === conv.id ? (
                <div className="conv-panel-edit">
                  <input
                    type="text"
                    className="conv-panel-edit-input"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveEdit(conv.id);
                      else if (e.key === "Escape") handleCancelEdit();
                    }}
                    autoFocus
                  />
                  <button className="conv-panel-action-btn" onClick={() => handleSaveEdit(conv.id)} type="button">
                    <IconCheck size={12} />
                  </button>
                  <button className="conv-panel-action-btn" onClick={handleCancelEdit} type="button">
                    <IconX size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <div
                    className="conv-panel-item-body"
                    onClick={() => onSelectConversation(conv.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && onSelectConversation(conv.id)}
                  >
                    <div className="conv-panel-item-title">{conv.title}</div>
                    {conv.lastMessagePreview && (
                      <div className="conv-panel-item-preview">{conv.lastMessagePreview}</div>
                    )}
                    <div className="conv-panel-item-meta">
                      <span className="conv-panel-item-time">{formatDate(conv.updatedAt)}</span>
                      {conv.messageCount > 0 && (
                        <span className="conv-panel-item-count">{conv.messageCount}</span>
                      )}
                    </div>
                  </div>
                  <div className="conv-panel-item-actions">
                    {confirmingDeleteId === conv.id ? (
                      <>
                        <button
                          className="conv-panel-action-btn danger"
                          onClick={() => handleConfirmDelete(conv.id)}
                          type="button"
                          title="确认删除"
                        >
                          <IconCheck size={12} />
                        </button>
                        <button
                          className="conv-panel-action-btn"
                          onClick={() => setConfirmingDeleteId(null)}
                          type="button"
                          title="取消"
                        >
                          <IconX size={12} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="conv-panel-action-btn"
                          onClick={() => handleStartEdit(conv)}
                          type="button"
                          title="重命名"
                        >
                          <IconEdit size={12} />
                        </button>
                        <button
                          className="conv-panel-action-btn danger"
                          onClick={() => setConfirmingDeleteId(conv.id)}
                          type="button"
                          title="删除"
                        >
                          <IconTrash size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
