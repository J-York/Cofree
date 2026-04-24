import type { ReactElement } from "react";
import type {
  AppSettings,
  ManagedModel,
  ToolPermissionLevel,
  VendorConfig,
  VendorProtocol,
} from "../../lib/settingsStore";

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

export type SettingsTab = "skills" | "model" | "tools" | "advanced" | "audit";

export const SETTINGS_TABS: { id: Exclude<SettingsTab, "audit">; label: string }[] = [
  { id: "skills", label: "Skills" },
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
  onThinkingSupportChange: (value: boolean) => void;
  onThinkingLevelChange: (value: ManagedModel["thinkingLevel"]) => void;
  onOpenMetaSettings: () => void;
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

export interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose?: () => void;
}

export interface SettingsFooterProps {
  saveMessage: string;
  onSave: () => void | Promise<void>;
}

export interface ModelTabProps {
  draft: AppSettings;
  runtimeEndpoint: string;
  activeVendor: VendorConfig | null;
  activeModelId: string | null;
  activeVendorModels: ManagedModel[];
  selectedVendorId: string | null;
  selectedVendor: VendorConfig | null;
  selectedVendorApiKey: string;
  selectedVendorModels: ManagedModel[];
  showNewVendor: boolean;
  newVendorName: string;
  newVendorProtocol: VendorProtocol;
  newVendorBaseUrl: string;
  manualModelName: string;
  editingModelId: string | null;
  editingModelName: string;
  confirmDeleteVendorId: string | null;
  confirmDeleteModelId: string | null;
  vendorMessage: string;
  fetchingVendorId: string | null;
  onSelectVendor: (vendorId: string) => void;
  onSelectedVendorApiKeyChange: (value: string) => void;
  onShowNewVendorChange: (value: boolean) => void;
  onNewVendorNameChange: (value: string) => void;
  onNewVendorProtocolChange: (value: VendorProtocol) => void;
  onNewVendorBaseUrlChange: (value: string) => void;
  onManualModelNameChange: (value: string) => void;
  onEditingModelIdChange: (value: string | null) => void;
  onEditingModelNameChange: (value: string) => void;
  onConfirmDeleteVendorChange: (value: string | null) => void;
  onConfirmDeleteModelChange: (value: string | null) => void;
  onUpdateSelectedVendor: (updates: Partial<Omit<VendorConfig, "id" | "createdAt">>) => void;
  onCreateVendor: () => void;
  onDeleteVendor: (vendorId: string) => Promise<void>;
  onRenameModel: (modelId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onUpdateModelThinking: (
    modelId: string,
    updates: Partial<Pick<ManagedModel, "supportsThinking" | "thinkingLevel">>,
  ) => void;
  onUpdateModelMetaSettings: (
    modelId: string,
    updates: Partial<ManagedModel["metaSettings"]>,
  ) => void;
  onAssignFirstModelForVendor: (vendorId: string) => void;
  onFetchVendorModels: () => Promise<void>;
  onAddManualModel: () => void;
  onSetActiveModel: (modelId: string) => void;
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
