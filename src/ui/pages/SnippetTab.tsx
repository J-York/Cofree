import { useEffect, useMemo, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../../lib/settingsStore";
import {
  addSnippet,
  deleteSnippet,
  setSnippets,
  updateSnippet,
} from "../../lib/settingsStore";
import {
  createCustomSnippetEntry,
  discoverGlobalSnippets,
  invalidateSnippetCache,
  mergeSnippets,
  serializeSnippetMarkdown,
  slugifySnippetName,
  type SnippetEntry,
} from "../../lib/snippetStore";

export interface SnippetTabProps {
  draft: AppSettings;
  setDraft: (
    updater: AppSettings | ((current: AppSettings) => AppSettings),
  ) => void;
}

function SnippetSourceBadge({
  source,
}: {
  source: SnippetEntry["source"];
}): ReactElement {
  const labels: Record<SnippetEntry["source"], string> = {
    "global-file": "全局",
    custom: "自定义",
  };
  return <span className="skill-source-badge">{labels[source]}</span>;
}

function SnippetRow({
  snippet,
  onToggle,
  onEdit,
  onDelete,
  confirmingDelete,
  onRequestDelete,
  onCancelDelete,
}: {
  snippet: SnippetEntry;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
}): ReactElement {
  return (
    <div className={`skill-row${snippet.enabled ? "" : " disabled"}`}>
      <div className="skill-row-main">
        <div className="skill-row-header">
          <span className="skill-name">{snippet.name}</span>
          <SnippetSourceBadge source={snippet.source} />
        </div>
        <p className="skill-description">{snippet.description || "无描述"}</p>
      </div>
      <div className="skill-row-actions">
        {confirmingDelete ? (
          <>
            <span className="settings-delete-confirm-text">确认删除？</span>
            <button
              className="btn btn-danger btn-sm"
              onClick={onDelete}
              type="button"
            >
              删除
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onCancelDelete}
              type="button"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              className={`skill-toggle-btn${snippet.enabled ? " active" : ""}`}
              onClick={onToggle}
              type="button"
              title={snippet.enabled ? "禁用" : "启用"}
            >
              {snippet.enabled ? "已启用" : "已禁用"}
            </button>
            <button
              className="skill-action-btn"
              onClick={onEdit}
              type="button"
              title="编辑"
            >
              ✏️
            </button>
            <button
              className="skill-action-btn danger"
              onClick={onRequestDelete}
              type="button"
              title="删除"
            >
              🗑
            </button>
          </>
        )}
      </div>
    </div>
  );
}

interface SnippetFormValues {
  name: string;
  description: string;
  body: string;
  storeOnDisk: boolean;
}

function SnippetForm({
  title,
  initial,
  diskOptionLocked,
  onSave,
  onCancel,
}: {
  title: string;
  initial: SnippetFormValues;
  /** When editing an existing entry, the source can't be flipped — disk vs.
   * custom is fixed by the original entry. */
  diskOptionLocked: boolean;
  onSave: (values: SnippetFormValues) => void | Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  const [storeOnDisk, setStoreOnDisk] = useState(initial.storeOnDisk);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedBody = body.trim();
    if (!trimmedName) {
      setError("请输入名称");
      return;
    }
    if (!trimmedDescription) {
      setError("请输入描述（@ 选择器需要展示）");
      return;
    }
    if (!trimmedBody) {
      setError("请输入注入到对话的正文内容");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSave({
        name: trimmedName,
        description: trimmedDescription,
        body: trimmedBody,
        storeOnDisk,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">{title}</h3>
      </div>

      <div className="field">
        <label className="field-label">名称</label>
        <input
          className="input"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="HDY 服务器操控"
        />
      </div>

      <div className="field">
        <label className="field-label">描述（@ 选择器中展示）</label>
        <input
          className="input"
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="HDY 测试服务器的连接方式、常用路径与运维约定"
        />
      </div>

      <div className="field">
        <label className="field-label">正文（注入到对话的内容）</label>
        <textarea
          className="textarea"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={10}
          placeholder="服务器地址：…&#10;SSH 端口：…&#10;运维约定：…"
        />
      </div>

      {!diskOptionLocked && (
        <div className="field">
          <label className="field-label">存储位置</label>
          <div className="skill-input-mode-toggle">
            <button
              className={`tool-toggle-btn${storeOnDisk ? " active" : ""}`}
              onClick={() => setStoreOnDisk(true)}
              type="button"
            >
              ~/.cofree/snippets/
            </button>
            <button
              className={`tool-toggle-btn${!storeOnDisk ? " active" : ""}`}
              onClick={() => setStoreOnDisk(false)}
              type="button"
            >
              仅本应用（自定义）
            </button>
          </div>
        </div>
      )}

      {error && <div className="settings-inline-feedback">{error}</div>}

      <div className="skill-form-actions">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          type="button"
          disabled={submitting}
        >
          {submitting ? "保存中…" : "保存"}
        </button>
        <button
          className="btn btn-secondary"
          onClick={onCancel}
          type="button"
          disabled={submitting}
        >
          取消
        </button>
      </div>
    </div>
  );
}

export function SnippetTab({ draft, setDraft }: SnippetTabProps): ReactElement {
  const [discovered, setDiscovered] = useState<SnippetEntry[]>([]);
  const [discoveryKey, setDiscoveryKey] = useState(0);
  const [discoveryError, setDiscoveryError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const entries = await discoverGlobalSnippets();
        if (cancelled) return;
        setDiscovered(entries);
        setDiscoveryError("");
      } catch (error) {
        if (cancelled) return;
        setDiscovered([]);
        setDiscoveryError(
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [discoveryKey]);

  const merged = useMemo(
    () => mergeSnippets(draft.snippets, discovered),
    [draft.snippets, discovered],
  );

  const editingSnippet = editingId
    ? merged.find((entry) => entry.id === editingId) ?? null
    : null;

  const handleSaveNew = async (values: SnippetFormValues) => {
    if (values.storeOnDisk) {
      const stem = slugifySnippetName(values.name);
      const content = serializeSnippetMarkdown({
        name: values.name,
        description: values.description,
        body: values.body,
      });
      try {
        await invoke<string>("write_snippet_file", {
          fileName: stem,
          content,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`写入磁盘失败：${msg}`);
      }
      invalidateSnippetCache();
      setDiscoveryKey((prev) => prev + 1);
      setFeedback({ text: `已保存到 ~/.cofree/snippets/${stem}.md`, type: "success" });
    } else {
      const entry = createCustomSnippetEntry({
        name: values.name,
        description: values.description,
        body: values.body,
      });
      setDraft((current) => addSnippet(current, entry));
      setFeedback({ text: "已新增自定义知识", type: "success" });
    }
    setCreating(false);
  };

  const handleSaveEdit = async (
    snippet: SnippetEntry,
    values: SnippetFormValues,
  ) => {
    if (snippet.source === "global-file") {
      // Re-write the same file on disk; preserves filename / id.
      const stem = snippet.filePath
        ? snippet.filePath
            .replace(/\\/g, "/")
            .split("/")
            .pop()
            ?.replace(/\.md$/i, "") ?? slugifySnippetName(values.name)
        : slugifySnippetName(values.name);
      const content = serializeSnippetMarkdown({
        name: values.name,
        description: values.description,
        body: values.body,
      });
      try {
        await invoke<string>("write_snippet_file", {
          fileName: stem,
          content,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`写入磁盘失败：${msg}`);
      }
      invalidateSnippetCache();
      setDiscoveryKey((prev) => prev + 1);
      setFeedback({ text: "已更新磁盘 Snippet", type: "success" });
    } else {
      setDraft((current) =>
        updateSnippet(current, snippet.id, {
          name: values.name,
          description: values.description,
          body: values.body,
        }),
      );
      setFeedback({ text: "已更新自定义知识", type: "success" });
    }
    setEditingId(null);
  };

  const handleToggle = (snippetId: string) => {
    setDraft((current) => {
      // Custom entries live in settings; toggle directly. File-based entries
      // are not persisted in `draft.snippets` until they get toggled, so we
      // first merge the discovered entry into settings to capture its state.
      const merged = mergeSnippets(current.snippets, discovered);
      const target = merged.find((entry) => entry.id === snippetId);
      if (!target) return current;
      const customs = current.snippets.filter(
        (entry) => entry.source === "custom",
      );
      const fileEntries = merged
        .filter((entry) => entry.source === "global-file")
        .map((entry) =>
          entry.id === snippetId ? { ...entry, enabled: !entry.enabled } : entry,
        );
      const customsToggled = customs.map((entry) =>
        entry.id === snippetId ? { ...entry, enabled: !entry.enabled } : entry,
      );
      return setSnippets(current, [...customsToggled, ...fileEntries]);
    });
  };

  const handleDelete = async (snippet: SnippetEntry) => {
    setConfirmingDeleteId(null);
    try {
      if (snippet.source === "global-file" && snippet.filePath) {
        const stem = snippet.filePath
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          ?.replace(/\.md$/i, "");
        if (!stem) {
          throw new Error("无法从文件路径中解析名称");
        }
        await invoke("delete_snippet_file", { fileName: stem });
        invalidateSnippetCache();
        setDiscoveryKey((prev) => prev + 1);
      }
      setDraft((current) => deleteSnippet(current, snippet.id));
      setFeedback({ text: `已删除 ${snippet.name}`, type: "success" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFeedback({ text: `删除失败：${msg}`, type: "error" });
    }
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-card-header">
          <div>
            <h3 className="settings-card-title">知识 / Snippets 管理</h3>
            <p className="settings-card-desc">
              知识是预先编写的提示片段。仅在你于聊天框使用 <code>@</code>{" "}
              主动选中后，对应正文才会注入当轮系统提示，绝不会自动激活。
            </p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditingId(null);
              setCreating(true);
            }}
            type="button"
          >
            + 新增知识
          </button>
        </div>

        <div className="settings-inline-feedback">
          <strong>知识来源：</strong>
          <br />•{" "}
          <strong>全局</strong>
          ：~/.cofree/snippets/&#123;name&#125;.md（带 YAML frontmatter）
          <br />• <strong>自定义</strong>
          ：仅保存在本应用设置里，不写入磁盘
        </div>
        {feedback && (
          <div className={`skill-install-feedback ${feedback.type}`}>
            {feedback.text}
          </div>
        )}
        {discoveryError && (
          <div className="settings-inline-feedback">{discoveryError}</div>
        )}
      </div>

      {creating && (
        <SnippetForm
          title="新增知识"
          diskOptionLocked={false}
          initial={{
            name: "",
            description: "",
            body: "",
            storeOnDisk: true,
          }}
          onSave={handleSaveNew}
          onCancel={() => setCreating(false)}
        />
      )}

      {editingSnippet && (
        <SnippetForm
          title={`编辑：${editingSnippet.name}`}
          diskOptionLocked
          initial={{
            name: editingSnippet.name,
            description: editingSnippet.description,
            body: editingSnippet.body,
            storeOnDisk: editingSnippet.source === "global-file",
          }}
          onSave={(values) => handleSaveEdit(editingSnippet, values)}
          onCancel={() => setEditingId(null)}
        />
      )}

      {merged.length === 0 ? (
        <div className="settings-card">
          <div className="settings-empty-state">
            <p>尚未注册任何知识。</p>
            <p className="settings-card-desc">
              点击右上角「新增知识」开始创建。
            </p>
          </div>
        </div>
      ) : (
        <div className="skill-list">
          {merged.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              onToggle={() => handleToggle(snippet.id)}
              onEdit={() => {
                setCreating(false);
                setEditingId(snippet.id);
              }}
              onDelete={() => handleDelete(snippet)}
              confirmingDelete={confirmingDeleteId === snippet.id}
              onRequestDelete={() => setConfirmingDeleteId(snippet.id)}
              onCancelDelete={() => setConfirmingDeleteId(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

