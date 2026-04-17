import { useEffect, useMemo, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../../lib/settingsStore";
import { deleteSkill, setSkills, toggleSkill, updateSkill } from "../../lib/settingsStore";
import { loadCofreeRc, convertCofreeRcSkillEntries } from "../../lib/cofreerc";
import {
  discoverGlobalSkills,
  discoverWorkspaceSkills,
  invalidateSkillCache,
  mergeDiscoveredSkills,
  type SkillEntry,
} from "../../lib/skillStore";

export interface SkillTabProps {
  draft: AppSettings;
  setDraft: (updater: AppSettings | ((current: AppSettings) => AppSettings)) => void;
}

function SkillSourceBadge({ source }: { source: SkillEntry["source"] }): ReactElement {
  const labels: Record<SkillEntry["source"], string> = {
    global: "全局",
    workspace: "工作区",
    cofreerc: ".cofreerc",
    custom: "自定义",
  };
  return <span className="skill-source-badge">{labels[source]}</span>;
}

function SkillRow({
  skill,
  onToggle,
  onDelete,
  onEdit,
  confirmingDelete,
  onRequestDelete,
  onCancelDelete,
}: {
  skill: SkillEntry;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
}): ReactElement {
  const canDelete = skill.source === "custom" || skill.source === "global";

  return (
    <div className={`skill-row${skill.enabled ? "" : " disabled"}`}>
      <div className="skill-row-main">
        <div className="skill-row-header">
          <span className="skill-name">{skill.name}</span>
          <SkillSourceBadge source={skill.source} />
        </div>
        <p className="skill-description">{skill.description || "无描述"}</p>
        {skill.keywords && skill.keywords.length > 0 && (
          <div className="skill-keywords">
            {skill.keywords.map((keyword) => (
              <span key={keyword} className="skill-keyword-tag">
                {keyword}
              </span>
            ))}
          </div>
        )}
        {skill.filePatterns && skill.filePatterns.length > 0 && (
          <div className="skill-file-patterns">
            <span className="skill-meta-label">文件模式：</span>
            {skill.filePatterns.join(", ")}
          </div>
        )}
      </div>
      <div className="skill-row-actions">
        {confirmingDelete ? (
          <>
            <span className="settings-delete-confirm-text">确认删除？</span>
            <button className="btn btn-danger btn-sm" onClick={onDelete} type="button">
              删除
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onCancelDelete} type="button">
              取消
            </button>
          </>
        ) : (
          <>
            <button
              className={`skill-toggle-btn${skill.enabled ? " active" : ""}`}
              onClick={onToggle}
              type="button"
              title={skill.enabled ? "禁用" : "启用"}
            >
              {skill.enabled ? "已启用" : "已禁用"}
            </button>
            {skill.source === "custom" && (
              <button className="skill-action-btn" onClick={onEdit} type="button" title="编辑">
                ✏️
              </button>
            )}
            {canDelete && (
              <button className="skill-action-btn danger" onClick={onRequestDelete} type="button" title="删除">
                🗑
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EditSkillForm({
  skill,
  onSave,
  onCancel,
}: {
  skill: SkillEntry;
  onSave: (updates: Partial<Omit<SkillEntry, "id" | "createdAt">>) => void;
  onCancel: () => void;
}): ReactElement {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions || "");
  const [filePath, setFilePath] = useState(skill.filePath || "");
  const [keywordsInput, setKeywordsInput] = useState(
    skill.keywords?.join(", ") || "",
  );
  const [filePatternsInput, setFilePatternsInput] = useState(
    skill.filePatterns?.join(", ") || "",
  );
  const [inputMode, setInputMode] = useState<"inline" | "file">(
    skill.filePath ? "file" : "inline",
  );

  const handleSave = () => {
    const keywords = keywordsInput
      .split(",")
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);
    const filePatterns = filePatternsInput
      .split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean);

    onSave({
      name: name.trim(),
      description: description.trim(),
      instructions: inputMode === "inline" ? instructions.trim() || undefined : undefined,
      filePath: inputMode === "file" ? filePath.trim() || undefined : undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
      filePatterns: filePatterns.length > 0 ? filePatterns : undefined,
    });
  };

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">编辑 Skill: {skill.name}</h3>
      </div>

      <div className="field">
        <label className="field-label">名称</label>
        <input
          className="input"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label">描述</label>
        <input
          className="input"
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label">指令来源</label>
        <div className="skill-input-mode-toggle">
          <button
            className={`tool-toggle-btn${inputMode === "inline" ? " active" : ""}`}
            onClick={() => setInputMode("inline")}
            type="button"
          >
            内联指令
          </button>
          <button
            className={`tool-toggle-btn${inputMode === "file" ? " active" : ""}`}
            onClick={() => setInputMode("file")}
            type="button"
          >
            文件路径
          </button>
        </div>
      </div>

      {inputMode === "inline" ? (
        <div className="field">
          <label className="field-label">指令内容</label>
          <textarea
            className="textarea"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={6}
          />
        </div>
      ) : (
        <div className="field">
          <label className="field-label">SKILL.md 文件路径</label>
          <input
            className="input"
            type="text"
            value={filePath}
            onChange={(event) => setFilePath(event.target.value)}
          />
        </div>
      )}

      <div className="field">
        <label className="field-label">关键词（逗号分隔）</label>
        <input
          className="input"
          type="text"
          value={keywordsInput}
          onChange={(event) => setKeywordsInput(event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label">文件模式（逗号分隔）</label>
        <input
          className="input"
          type="text"
          value={filePatternsInput}
          onChange={(event) => setFilePatternsInput(event.target.value)}
        />
      </div>

      <div className="skill-form-actions">
        <button className="btn btn-primary" onClick={handleSave} type="button">
          保存
        </button>
        <button className="btn btn-secondary" onClick={onCancel} type="button">
          取消
        </button>
      </div>
    </div>
  );
}

export function SkillTab({ draft, setDraft }: SkillTabProps): ReactElement {
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [discoveredSkills, setDiscoveredSkills] = useState<SkillEntry[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string>("");
  const [installMessage, setInstallMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [discoveryKey, setDiscoveryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const loadDiscoveredSkills = async () => {
      try {
        const workspacePath = draft.workspacePath.trim();
        const [globalSkills, workspaceSkills, cofreeRcSkills] = await Promise.all([
          discoverGlobalSkills(),
          workspacePath ? discoverWorkspaceSkills(workspacePath) : Promise.resolve([]),
          workspacePath
            ? loadCofreeRc(workspacePath).then((config) =>
                convertCofreeRcSkillEntries(config, workspacePath),
              )
            : Promise.resolve([]),
        ]);

        if (cancelled) {
          return;
        }

        setDiscoveryError("");
        setDiscoveredSkills([...globalSkills, ...workspaceSkills, ...cofreeRcSkills]);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setDiscoveredSkills([]);
        setDiscoveryError("自动发现 Skills 失败，请检查工作区路径和配置后重试。");
        console.warn("[skills] Failed to discover settings skills", error);
      }
    };

    void loadDiscoveredSkills();
    return () => {
      cancelled = true;
    };
  }, [draft.workspacePath, discoveryKey]);

  const mergedSkills = useMemo(
    () => mergeDiscoveredSkills(draft.skills, discoveredSkills),
    [draft.skills, discoveredSkills],
  );

  const handleInstallSkill = async () => {
    setInstalling(true);
    setInstallMessage(null);
    try {
      const skillName = await invoke<string>("install_skill_from_zip");
      invalidateSkillCache();
      setDiscoveryKey((prev) => prev + 1);
      setInstallMessage({ text: `Skill "${skillName}" 安装成功`, type: "success" });
    } catch (error) {
      const msg = String(error);
      if (msg !== "用户取消了选择") {
        setInstallMessage({ text: msg, type: "error" });
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleToggleSkill = (skillId: string) => {
    setDraft((current) => {
      const merged = mergeDiscoveredSkills(current.skills, discoveredSkills);
      const withDiscovered = setSkills(current, merged);
      return toggleSkill(withDiscovered, skillId);
    });
  };

  const handleDeleteSkill = async (skill: SkillEntry) => {
    const canDeleteFromDisk = skill.source === "global" && !!skill.filePath;

    if (canDeleteFromDisk) {
      try {
        await invoke("delete_skill_directory", { filePath: skill.filePath });
        invalidateSkillCache();
      } catch (error) {
        setInstallMessage({ text: String(error), type: "error" });
        return;
      }
    }

    setConfirmingDeleteId(null);
    setDraft((current) => deleteSkill(current, skill.id));
    setDiscoveryKey((prev) => prev + 1);
  };

  const handleUpdateSkill = (
    skillId: string,
    updates: Partial<Omit<SkillEntry, "id" | "createdAt">>,
  ) => {
    setDraft((current) => updateSkill(current, skillId, updates));
    setEditingSkillId(null);
  };

  const editingSkill = editingSkillId
    ? mergedSkills.find((skill) => skill.id === editingSkillId)
    : null;

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="settings-card-header">
          <div>
            <h3 className="settings-card-title">Skills 管理</h3>
            <p className="settings-card-desc">
              Skills 是可复用的领域能力扩展。AI 会根据你的消息和正在编辑的文件自动匹配并激活相关
              Skill，将其指令注入到系统提示中。
            </p>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleInstallSkill}
            type="button"
            disabled={installing}
          >
            {installing ? "安装中…" : "+ 安装 Skill"}
          </button>
        </div>

        <div className="settings-inline-feedback">
          <strong>Skill 来源：</strong>
          <br />
          • <strong>全局</strong>：~/.cofree/skills/&#123;name&#125;/SKILL.md（通过 zip 安装包安装）
          <br />
          • <strong>工作区</strong>：&#123;workspace&#125;/.cofree/skills/&#123;name&#125;/SKILL.md
          <br />
          • <strong>.cofreerc</strong>：.cofreerc 文件中的 skills 配置
        </div>
        {installMessage && (
          <div className={`skill-install-feedback ${installMessage.type}`}>
            {installMessage.text}
          </div>
        )}
        {discoveryError && <div className="settings-inline-feedback">{discoveryError}</div>}
      </div>

      {editingSkill && (
        <EditSkillForm
          skill={editingSkill}
          onSave={(updates) => handleUpdateSkill(editingSkill.id, updates)}
          onCancel={() => setEditingSkillId(null)}
        />
      )}

      {mergedSkills.length === 0 ? (
        <div className="settings-card">
          <div className="settings-empty-state">
            <p>暂无已注册的 Skill。</p>
            <p className="settings-card-desc">
              点击上方「安装 Skill」按钮，选择 zip 安装包来添加新 Skill。
            </p>
          </div>
        </div>
      ) : (
        <div className="skill-list">
          {mergedSkills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              onToggle={() => handleToggleSkill(skill.id)}
              onDelete={() => handleDeleteSkill(skill)}
              onEdit={() => setEditingSkillId(skill.id)}
              confirmingDelete={confirmingDeleteId === skill.id}
              onRequestDelete={() => setConfirmingDeleteId(skill.id)}
              onCancelDelete={() => setConfirmingDeleteId(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
