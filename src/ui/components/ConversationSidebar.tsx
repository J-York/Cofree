/**
 * Cofree - AI Programming Cafe
 * File: src/ui/components/ConversationSidebar.tsx
 * Description: Collapsible overlay drawer for managing conversations
 */

import { type ReactElement, useEffect, useRef, useState } from "react";
import type { ConversationMetadata } from "../../lib/conversationStore";

interface ConversationSidebarProps {
  conversations: ConversationMetadata[];
  activeConversationId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, newTitle: string) => void;
}

export function ConversationSidebar({
  conversations,
  activeConversationId,
  isOpen,
  onClose,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
}: ConversationSidebarProps): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handleStartEdit = (conversation: ConversationMetadata) => {
    setEditingId(conversation.id);
    setEditingTitle(conversation.title);
  };

  const handleSaveEdit = (conversationId: string) => {
    if (editingTitle.trim()) {
      onRenameConversation(conversationId, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const handleDelete = (conversationId: string) => {
    setConfirmingDeleteId(conversationId);
  };

  const handleConfirmDelete = (conversationId: string) => {
    setConfirmingDeleteId(null);
    onDeleteConversation(conversationId);
  };

  const handleCancelDelete = () => {
    setConfirmingDeleteId(null);
  };

  const handleSelect = (id: string) => {
    onSelectConversation(id);
    onClose();
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
    <>
      {/* Backdrop */}
      <div
        className={`conv-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={`conv-drawer${isOpen ? " open" : ""}`}
        role="dialog"
        aria-label="对话列表"
        aria-modal="true"
      >
        {/* Drawer header */}
        <div className="conv-drawer-header">
          <span className="conv-drawer-title">对话列表</span>
          <div className="conv-drawer-header-actions">
            <button
              className="conv-new-btn"
              onClick={onNewConversation}
              type="button"
              title="新建对话"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              新建对话
            </button>
            <button
              className="conv-close-btn"
              onClick={onClose}
              type="button"
              aria-label="关闭"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* List */}
        <div className="conv-list">
          {conversations.length === 0 ? (
            <div className="conv-empty">
              <div className="conv-empty-icon">💬</div>
              <p>暂无对话记录</p>
              <p className="conv-empty-hint">点击「新建对话」开始</p>
            </div>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`conv-item${activeConversationId === conversation.id ? " active" : ""}`}
              >
                {editingId === conversation.id ? (
                  <div className="conv-edit">
                    <input
                      type="text"
                      className="input conv-edit-input"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveEdit(conversation.id);
                        else if (e.key === "Escape") handleCancelEdit();
                      }}
                      autoFocus
                    />
                    <div className="conv-edit-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSaveEdit(conversation.id)}
                        type="button"
                      >
                        保存
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleCancelEdit}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      className="conv-item-body"
                      onClick={() => handleSelect(conversation.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && handleSelect(conversation.id)}
                    >
                      <div className="conv-item-title">{conversation.title}</div>
                      <div className="conv-item-meta">
                        {formatDate(conversation.updatedAt)}
                        {conversation.messageCount > 0 && (
                          <span className="conv-item-count">{conversation.messageCount} 条</span>
                        )}
                      </div>
                    </div>
                    <div className="conv-item-actions">
                      <button
                        className="conv-action-btn"
                        onClick={(e) => { e.stopPropagation(); handleStartEdit(conversation); }}
                        type="button"
                        title="重命名"
                        aria-label="重命名"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M8.5 1.5a1.414 1.414 0 012 2L3.5 10.5l-3 .5.5-3 7.5-6.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      {confirmingDeleteId === conversation.id ? (
                        <>
                          <button
                            className="conv-action-btn danger"
                            onClick={(e) => { e.stopPropagation(); handleConfirmDelete(conversation.id); }}
                            type="button"
                            title="确认删除"
                            aria-label="确认删除"
                          >
                            ✓
                          </button>
                          <button
                            className="conv-action-btn"
                            onClick={(e) => { e.stopPropagation(); handleCancelDelete(); }}
                            type="button"
                            title="取消"
                            aria-label="取消"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <button
                          className="conv-action-btn danger"
                          onClick={(e) => { e.stopPropagation(); handleDelete(conversation.id); }}
                          type="button"
                          title="删除"
                          aria-label="删除"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M1.5 3h9M4 3V2h4v1M5 5.5v3M7 5.5v3M2.5 3l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
