import type { ReactElement } from "react";
import type { AppSettings, ManagedModel, ToolPermissionLevel, VendorProtocol } from "../../lib/settingsStore";
import type { ChatAgentDefinition, SubAgentRole } from "../../agents/types";

export interface WorkspaceInfo {
  git_branch?: string;
  repo_name?: string;
}

export interface SettingsPageProps {
  settings: AppSettings;
  onSave: (
    settings: AppSettings,
    vendorApiKeys?: Record<string, string>,
  ) => Promise<void>;
  onClose?: () => void;
}

export type SettingsTab = "agents" | "model" | "tools" | "advanced";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "agents", label: "Agent 管理" },
  { id: "model", label: "模型配置" },
  { id: "tools", label: "工具权限" },
  { id: "advanced", label: "高级" },
];

export interface ToolPermissionRowProps {
  toolKey: keyof AppSettings["toolPermissions"];
  description: string;
  value: ToolPermissionLevel;
  onChange: (value: ToolPermissionLevel) => void;
}

export interface VendorModelRowProps {
  model: ManagedModel;
  isEditing: boolean;
  editingName: string;
  confirmDelete: boolean;
  canDelete: boolean;
  onStartEdit: () => void;
  onEditChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onConfirmDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}

export interface ModelPickerOverlayProps {
  fetchedModelIds: string[];
  existingModelNames: Set<string>;
  search: string;
  onSearchChange: (value: string) => void;
  selected: Set<string>;
  onToggle: (modelId: string) => void;
  onSelectAllNew: () => void;
  onDeselectAll: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface AgentEditorProps {
  agent: ChatAgentDefinition;
  isBuiltin: boolean;
  isOverridden: boolean;
  originalBuiltin: ChatAgentDefinition | null;
  vendors: AppSettings["vendors"];
  managedModels: ManagedModel[];
  confirmDeleteId: string | null;
  onUpdate: (updates: Partial<Omit<ChatAgentDefinition, "id" | "builtin">>) => void;
  onReset: () => void;
  onClone: () => void;
  onConfirmDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}

export const SUB_AGENT_ROLES: { role: SubAgentRole; label: string }[] = [
  { role: "planner", label: "Planner（规划）" },
  { role: "coder", label: "Coder（编码）" },
  { role: "tester", label: "Tester（测试）" },
  { role: "debugger", label: "Debugger（调试）" },
  { role: "reviewer", label: "Reviewer（代码审查）" },
];

export interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose?: () => void;
}

export interface SettingsFooterProps {
  saveMessage: string;
  onSave: () => void | Promise<void>;
}

export interface AgentsTabProps {
  draft: AppSettings;
  allAgents: ChatAgentDefinition[];
  selectedAgent: ChatAgentDefinition | null;
  selectedAgentId: string | null;
  isSelectedBuiltin: boolean;
  isSelectedOverridden: boolean;
  originalBuiltin: ChatAgentDefinition | null;
  confirmDeleteAgentId: string | null;
  showNewAgent: boolean;
  newAgentName: string;
  setSelectedAgentId: (value: string | null) => void;
  setConfirmDeleteAgentId: (value: string | null) => void;
  setShowNewAgent: (value: boolean) => void;
  setNewAgentName: (value: string) => void;
  setDraft: (updater: AppSettings | ((current: AppSettings) => AppSettings)) => void;
}

export interface ModelTabProps {
  draft: AppSettings;
  selectedVendorId: string | null;
  setSelectedVendorId: (value: string | null) => void;
  vendorApiKeys: Record<string, string>;
  setVendorApiKeys: (updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
  showNewVendor: boolean;
  setShowNewVendor: (value: boolean) => void;
  newVendorName: string;
  setNewVendorName: (value: string) => void;
  newVendorProtocol: VendorProtocol;
  setNewVendorProtocol: (value: VendorProtocol) => void;
  newVendorBaseUrl: string;
  setNewVendorBaseUrl: (value: string) => void;
  manualModelName: string;
  setManualModelName: (value: string) => void;
  editingModelId: string | null;
  setEditingModelId: (value: string | null) => void;
  editingModelName: string;
  setEditingModelName: (value: string) => void;
  confirmDeleteVendorId: string | null;
  setConfirmDeleteVendorId: (value: string | null) => void;
  confirmDeleteModelId: string | null;
  setConfirmDeleteModelId: (value: string | null) => void;
  vendorMessage: string;
  setVendorMessage: (value: string) => void;
  fetchingVendorId: string | null;
  fetchedModelIds: string[];
  showModelPicker: boolean;
  modelPickerSearch: string;
  setModelPickerSearch: (value: string) => void;
  modelPickerSelected: Set<string>;
  setModelPickerSelected: (value: Set<string> | ((current: Set<string>) => Set<string>)) => void;
  runtimeEndpoint: string;
  onCreateVendor: () => void;
  onDeleteVendor: (vendorId: string) => Promise<void>;
  onRenameModel: (modelId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onAssignFirstModelForVendor: (vendorId: string) => void;
  onFetchVendorModels: () => Promise<void>;
  onConfirmModelPick: () => void;
  onCloseModelPicker: () => void;
  onAddManualModel: () => void;
  onSetActiveModel: (modelId: string) => void;
  setDraft: (updater: AppSettings | ((current: AppSettings) => AppSettings)) => void;
}

export interface ToolsTabProps {
  draft: AppSettings;
  setDraft: (updater: AppSettings | ((current: AppSettings) => AppSettings)) => void;
}

export interface AdvancedTabProps {
  draft: AppSettings;
  workspaceInfo: WorkspaceInfo | null;
  workspaceError: string;
  clearScope: "workspace" | "all";
  confirmClearScope: "workspace" | "all" | null;
  setClearScope: (value: "workspace" | "all") => void;
  setConfirmClearScope: (value: "workspace" | "all" | null) => void;
  onSelectWorkspace: () => Promise<void>;
  onClearWorkspaceHistory: () => void;
  onClearAllHistory: () => void;
  setDraft: (updater: AppSettings | ((current: AppSettings) => AppSettings)) => void;
}

export type ExtractedSettingsComponent = (props: any) => ReactElement;
