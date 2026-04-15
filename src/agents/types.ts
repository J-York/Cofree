/**
 * Cofree - AI Programming Cafe
 * File: src/agents/types.ts
 * Description: Agent domain types shared across the application.
 */

import type { ToolPermissionLevel } from "../lib/settingsStore";
import type { ModelSelection } from "../lib/modelSelection";

// ---------------------------------------------------------------------------
// ChatAgent layer (user-selectable, top-level)
// ---------------------------------------------------------------------------

export type ChatAgentId = string;

export interface ChatAgentToolPolicy {
  enabledTools?: string[];
  toolPermissionOverrides?: Partial<Record<string, ToolPermissionLevel>>;
}

export interface ChatAgentDefinition {
  id: ChatAgentId;
  name: string;
  description: string;
  icon?: string;
  systemPromptTemplate: string;
  toolPolicy: ChatAgentToolPolicy;
  modelSelection?: ModelSelection;
  /** Whether this agent should use the global model settings by default */
  useGlobalModel?: boolean;
  builtin: boolean;
}

// ---------------------------------------------------------------------------
// Resolved runtime (produced by the resolver before each request)
// ---------------------------------------------------------------------------

export interface ResolvedAgentRuntime {
  agentId: ChatAgentId;
  agentName: string;
  systemPrompt: string;
  enabledTools: string[];
  toolPermissions: Record<string, ToolPermissionLevel>;
  vendorId: string;
  modelId: string;
  modelRef: string;
  vendorProtocol: string;
  baseUrl: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Agent override / customization (persisted in settings)
// ---------------------------------------------------------------------------

export type ChatAgentOverride = Partial<
  Omit<ChatAgentDefinition, "id" | "builtin">
>;

export const ALL_AGENT_TOOL_NAMES = [
  "list_files", "read_file", "grep", "glob",
  "git_status", "git_diff",
  "propose_file_edit", "propose_apply_patch", "propose_shell",
  "check_shell_job",
  "diagnostics", "fetch",
] as const;

export const AGENT_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  label: string;
  category: "read" | "write";
}> = [
  { name: "list_files", label: "列出文件", category: "read" },
  { name: "read_file", label: "读取文件", category: "read" },
  { name: "grep", label: "全文搜索", category: "read" },
  { name: "glob", label: "匹配文件", category: "read" },
  { name: "git_status", label: "Git 状态", category: "read" },
  { name: "git_diff", label: "Git 差异", category: "read" },
  { name: "diagnostics", label: "诊断", category: "read" },
  { name: "check_shell_job", label: "查询后台进程", category: "read" },
  { name: "propose_file_edit", label: "编辑文件", category: "write" },
  { name: "propose_apply_patch", label: "应用补丁", category: "write" },
  { name: "propose_shell", label: "执行命令", category: "write" },
  { name: "fetch", label: "网络请求", category: "write" },
];

// ---------------------------------------------------------------------------
// Conversation-level agent binding (persisted with each conversation)
// ---------------------------------------------------------------------------

export type AgentBindingSource = "default" | "user-override";

export interface ConversationAgentBinding {
  agentId: ChatAgentId;
  vendorId: string;
  modelId: string;
  bindingSource: AgentBindingSource;
  /** Snapshot of agent name at binding time for display even if agent is removed later. */
  agentNameSnapshot: string;
  vendorNameSnapshot?: string;
  modelNameSnapshot?: string;
  boundAt: string;
}
