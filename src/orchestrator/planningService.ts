/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/planningService.ts
 * Milestone: 3
 * Task: 3.5
 * Status: In Progress
 * Owner: Codex-GPT-5
 * Last Modified: 2026-03-01
 * Description: Native tool-calling orchestration loop with explicit HITL gate generation.
 */

import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_AGENTS } from "../agents/defaultAgents";
import { recordLLMAudit } from "../lib/auditLog";
import {
  createLiteLLMRequestBody,
  postLiteLLMChatCompletions,
  postLiteLLMChatCompletionsStream,
  type LiteLLMMessage,
  type LiteLLMToolDefinition,
} from "../lib/litellm";
import {
  DEFAULT_TOOL_PERMISSIONS,
  isActiveModelLocal,
  type AppSettings,
  type ToolPermissions,
} from "../lib/settingsStore";
import type { ActionProposal, OrchestrationPlan, PlanStep } from "./types";
import {
  summarizeWorkspaceFiles,
  type WorkspaceOverviewBudget,
} from "./readOnlyWorkspaceService";
import {
  loadCofreeRc,
  buildCofreeRcPromptFragment,
  type CofreeRcConfig,
} from "../lib/cofreerc";
import { SummaryCache } from "../lib/summaryCache";
import {
  compressMessagesToFitBudget,
  estimateTokensForMessages,
  estimateTokensForToolDefinitions,
  updateTokenCalibration,
} from "./contextBudget";
import type { ResolvedAgentRuntime, SubAgentRole, ConversationAgentBinding, StructuredSubAgentOutput } from "../agents/types";
import { resolveAgentRuntime } from "../agents/resolveAgentRuntime";
import { assembleSystemPrompt, assembleRuntimeContext } from "../agents/promptAssembly";
import { selectAgentTools } from "../agents/toolPolicy";
import { tryExtractStructuredOutput } from "../agents/structuredOutput";
import {
  createWorkingMemory,
  extractFileKnowledge,
  addDiscoveredFact,
  recordSubAgentExecution,
  serializeWorkingMemory,
  type WorkingMemory,
} from "./workingMemory";
const TOOL_LOOP_CHECKPOINT_TURNS = 50;
const TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD = 40;
const MAX_LIST_ENTRIES = 120;
const MAX_FILE_PREVIEW_CHARS = 15000;
const MAX_TOOL_RESULT_PREVIEW = 400;

// --- Phase 4: Context management budgets ---
const SUMMARY_CACHE_TTL_MS = 10 * 60 * 1000;
const SUMMARY_CACHE_MAX_ENTRIES = 100;
const BASE_SUMMARY_COOLDOWN_MS = 60 * 1000;

const MIN_MESSAGES_TO_SUMMARIZE = 4;
const MIN_RECENT_MESSAGES_TO_KEEP = 6;
const RECENT_TOKENS_MIN_RATIO = 0.4;
const TOOL_MESSAGE_MAX_CHARS = 3000;

// P2-2: Dynamic cooldown state — tracks token growth to adjust cooldown.
// Capped at MAX_TRACKED_WORKSPACES to prevent unbounded memory growth.
const MAX_TRACKED_WORKSPACES = 20;
const TRACKER_STALE_MS = 30 * 60 * 1000; // evict entries idle for >30 min

const tokenGrowthTracker = new Map<string, { timestamps: number[]; tokenCounts: number[] }>();

function evictStaleTrackers(now: number): void {
  if (tokenGrowthTracker.size <= MAX_TRACKED_WORKSPACES) return;

  for (const [key, tracker] of tokenGrowthTracker) {
    const lastTs = tracker.timestamps[tracker.timestamps.length - 1] ?? 0;
    if (now - lastTs > TRACKER_STALE_MS) {
      tokenGrowthTracker.delete(key);
    }
  }

  // Hard cap: if still over limit, remove oldest entries.
  while (tokenGrowthTracker.size > MAX_TRACKED_WORKSPACES) {
    const oldestKey = tokenGrowthTracker.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tokenGrowthTracker.delete(oldestKey);
  }
}

function computeDynamicCooldownMs(workspacePath: string | undefined, currentTokens: number): number {
  const ws = workspacePath?.trim() || "";
  if (!ws) return BASE_SUMMARY_COOLDOWN_MS;

  const now = Date.now();
  evictStaleTrackers(now);

  let tracker = tokenGrowthTracker.get(ws);
  if (!tracker) {
    tracker = { timestamps: [], tokenCounts: [] };
    tokenGrowthTracker.set(ws, tracker);
  }

  tracker.timestamps.push(now);
  tracker.tokenCounts.push(currentTokens);

  // Keep only the last 10 samples
  while (tracker.timestamps.length > 10) {
    tracker.timestamps.shift();
    tracker.tokenCounts.shift();
  }

  if (tracker.timestamps.length < 2) return BASE_SUMMARY_COOLDOWN_MS;

  const timeDelta = tracker.timestamps[tracker.timestamps.length - 1] - tracker.timestamps[0];
  const tokenDelta = tracker.tokenCounts[tracker.tokenCounts.length - 1] - tracker.tokenCounts[0];

  if (timeDelta <= 0) return BASE_SUMMARY_COOLDOWN_MS;

  const growthRate = tokenDelta / (timeDelta / 1000);

  if (growthRate > 500) return 15_000;
  if (growthRate > 200) return 30_000;
  return BASE_SUMMARY_COOLDOWN_MS;
}

// P1-2: Max chars per chunk for map-reduce summarization
const SUMMARY_CHUNK_MAX_CHARS = 8000;

const MAX_TOOL_OUTPUT_CHARS = 15000; // hard cap for tool content injected into LLM context
const MAX_GREP_PREVIEW_MATCHES = 30;
const MAX_GREP_PREVIEW_CHARS = 8000;
const MAX_GLOB_PREVIEW_FILES = 60;
const MAX_GLOB_PREVIEW_CHARS = 6000;
// (reserved) diagnostics preview is already aggregated server-side; keep only a hard char cap.
// const MAX_DIAGNOSTICS_PREVIEW_ENTRIES = 30;
// const MAX_DIAGNOSTICS_MESSAGE_CHARS = 240;
const MAX_FETCH_PREVIEW_CHARS = 10000;
const MAX_TOOL_RETRY = 2;
const MAX_PATCH_REPAIR_ROUNDS = 1;
const MAX_CREATE_HINT_REPAIR_ROUNDS = 1;
const MAX_MULTI_ARTIFACT_REMINDER_ROUNDS = 2;
const MAX_PROPOSED_ACTIONS_PER_BATCH = 5;

const MAX_TOOL_NOT_FOUND_STRIKES = 3;
const MAX_CONSECUTIVE_FAILURE_TURNS = 5;

/**
 * Find the nearest line boundary before or at the given index.
 */
function truncateAtLineEnd(content: string, maxIndex: number): number {
  if (maxIndex >= content.length) return content.length;
  const lastNewline = content.lastIndexOf("\n", maxIndex);
  return lastNewline >= 0 ? lastNewline + 1 : maxIndex;
}

/**
 * Find the nearest line boundary after or at the given index.
 */
function truncateAtLineStart(content: string, minIndex: number): number {
  if (minIndex <= 0) return 0;
  const nextNewline = content.indexOf("\n", minIndex);
  return nextNewline >= 0 ? nextNewline + 1 : minIndex;
}

/**
 * Smart truncation that preserves both head and tail of content.
 * Truncates from the middle while respecting line boundaries.
 * @param content The string to truncate
 * @param maxLength Maximum allowed length
 * @param headRatio Ratio of head content to preserve (0-1), defaults to 0.5
 */
function smartTruncate(
  content: string,
  maxLength: number,
  headRatio = 0.5
): string {
  if (content.length <= maxLength) return content;

  const ellipsis = "\n\n...[已截断中间部分]...\n\n";
  const availableLength = maxLength - ellipsis.length;
  if (availableLength <= 0) return content.slice(0, maxLength);

  const headTarget = Math.floor(availableLength * headRatio);
  const tailTarget = availableLength - headTarget;

  const headEnd = truncateAtLineEnd(content, headTarget);
  const tailStart = truncateAtLineStart(content, content.length - tailTarget);

  // Avoid overlap
  if (headEnd >= tailStart) {
    return content.slice(0, maxLength);
  }

  return content.slice(0, headEnd) + ellipsis + content.slice(tailStart);
}

interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolExecutionResult {
  content: string;
  proposedAction?: ActionProposal;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  success?: boolean;
}

interface ChatCompletionChoiceMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface ChatCompletionPayload {
  id?: string;
  choices?: Array<{
    message?: ChatCompletionChoiceMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
}

const TOOL_DEFINITIONS: LiteLLMToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files/directories under workspace relative path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            description:
              "Workspace-relative directory path. Empty means workspace root.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file by workspace-relative path. Returns line-numbered content, total_lines, and showing_lines range. " +
        "For large files (500+ lines), use start_line/end_line to read in segments (e.g. 1-300, then 301-600).",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path.",
          },
          start_line: {
            type: "number",
            minimum: 1,
            description: "Optional 1-based start line for partial read.",
          },
          end_line: {
            type: "number",
            minimum: 1,
            description: "Optional 1-based end line for partial read.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Get git status summary in workspace repository. Returns empty result for non-git directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Get workspace git diff, optionally filtered to one file. Returns empty result for non-git directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Optional workspace-relative file path.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents in workspace using a regular expression pattern. Returns matching lines with file paths and line numbers. " +
        "Use this to quickly locate code, function definitions, variable usages, imports, etc. Much faster than reading files one by one.",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description:
              "Regular expression pattern to search for in file contents.",
          },
          include_glob: {
            type: "string",
            description:
              "Optional glob pattern to filter files (e.g. '*.ts', '*.py'). Matches against both file name and relative path.",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 200,
            description:
              "Maximum number of matching lines to return. Defaults to 50.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files in workspace by glob pattern matching. Returns matching file paths sorted by modification time (most recent first). " +
        "Use this to discover project structure, find files by extension or naming convention. Automatically excludes .git, node_modules, target, etc.",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description:
              "Glob pattern to match files (e.g. '**/*.tsx', 'src/**/*.py', '**/test_*.js').",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 500,
            description:
              "Maximum number of matching files to return. Defaults to 100.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_apply_patch",
      description:
        "Advanced raw patch path. Propose a write action by submitting unified diff patch for HITL approval (does not execute). Use only when explicit patch/diff is requested or structured edits cannot express the task.\n\nMinimal example:\ndiff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line",
      parameters: {
        type: "object",
        required: ["patch"],
        additionalProperties: false,
        properties: {
          patch: {
            type: "string",
            description:
              "Unified diff patch content. MUST include 'diff --git' header. For new files: 'diff --git a/file b/file' then '--- /dev/null' and '+++ b/file'. For edits: 'diff --git a/file b/file' then '--- a/file' and '+++ b/file'. For delete-file patches: include 'deleted file mode 100644', then '--- a/file' and '+++ /dev/null'.",
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_file_edit",
      description:
        "Propose deterministic single-file text edit. Supports replace/insert/delete/create operations. System will generate and validate patch for HITL approval.\n\nUsage examples:\n- Create new file: {relative_path:'src/foo.ts', operation:'create', content:'...'}\n- Replace by search: {relative_path:'src/foo.ts', search:'old text', replace:'new text'}\n- Replace by line range: {relative_path:'src/foo.ts', start_line:10, end_line:15, content:'replacement'}\n- Insert after line: {relative_path:'src/foo.ts', operation:'insert', line:5, content:'new line'}\n- Delete snippet: {relative_path:'src/foo.ts', operation:'delete', search:'text to remove'}\n\nIMPORTANT: relative_path is REQUIRED for all operations.",
      parameters: {
        type: "object",
        required: ["relative_path"],
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path.",
          },
          operation: {
            type: "string",
            enum: ["replace", "insert", "delete", "create"],
            description:
              "Edit operation. Defaults to 'replace' for backward compatibility.",
          },
          search: {
            type: "string",
            description:
              "For replace/delete-in-file: exact snippet to find. For backward-compatible insert, may be used as anchor.",
          },
          replace: {
            type: "string",
            description:
              "For replace: replacement text. For backward-compatible insert/create, may be used as inserted/content text.",
          },
          anchor: {
            type: "string",
            description: "For insert: exact anchor snippet in file.",
          },
          line: {
            type: "number",
            minimum: 1,
            description:
              "For insert: 1-based target line used as insertion anchor.",
          },
          start_line: {
            type: "number",
            minimum: 1,
            description:
              "For replace/delete: optional 1-based start line of the target range.",
          },
          end_line: {
            type: "number",
            minimum: 1,
            description:
              "For replace/delete: optional 1-based end line of the target range.",
          },
          content: {
            type: "string",
            description: "For insert/create: inserted or full file content.",
          },
          position: {
            type: "string",
            enum: ["before", "after"],
            description:
              "For insert: insert before or after anchor. Defaults to 'after'.",
          },
          replace_all: {
            type: "boolean",
            description:
              "For replace: replace all matches. For backward compatibility, also used as generic apply_all flag.",
          },
          apply_all: {
            type: "boolean",
            description:
              "For replace/insert/delete-in-file: apply operation to all matches.",
          },
          overwrite: {
            type: "boolean",
            description:
              "For create: when true and file already exists, update file content instead of failing.",
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_shell",
      description:
        "Propose a shell command execution action for HITL approval (does not execute). Supports full shell syntax including pipes, redirects, and chaining.\n\nExamples:\n- propose_shell(shell='npm install && npm test')\n- propose_shell(shell='rm -r old_dir')\n- propose_shell(shell='git add . && git commit -m \"Update\"')\n- propose_shell(shell='cargo build --release')\n\nThe command will be shown to the user for approval before execution.",
      parameters: {
        type: "object",
        required: ["shell"],
        additionalProperties: false,
        properties: {
          shell: {
            type: "string",
            minLength: 1,
            description:
              "Full shell command string. Can use pipes (|), redirects (>, <), chaining (&&, ;), variables ($VAR), etc.",
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description:
              "Optional execution timeout in milliseconds. Defaults to 120000 (2 minutes).",
          },
          description: {
            type: "string",
            description: "Optional short description for reviewers.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description:
        "Delegate a sub-task to a specialized sub-agent. The sub-agent runs an independent tool-calling loop with its own context and returns a summary of results. " +
        "Use this to parallelize work or delegate specialized tasks (e.g. ask the planner to analyze, the coder to implement, or the tester to validate).\n\n" +
        "The sub-agent inherits the current workspace and tool permissions but operates with a focused system prompt based on its role. " +
        "Sub-agent results (including any proposed actions) are collected and returned to you.\n\n" +
        "Example: task(role='coder', description='Implement the UserService class with CRUD methods in src/services/userService.ts')",
      parameters: {
        type: "object",
        required: ["role", "description"],
        additionalProperties: false,
        properties: {
          role: {
            type: "string",
            enum: ["planner", "coder", "tester"],
            description: "The role of the sub-agent to delegate to.",
          },
          description: {
            type: "string",
            minLength: 1,
            description:
              "Detailed description of the sub-task for the sub-agent to execute.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diagnostics",
      description:
        "Get compilation errors and warnings for the workspace. " +
        "Automatically detects project type (TypeScript, Rust, Python, Go) and runs the appropriate checker (tsc, cargo check, py_compile, etc.). " +
        "Use this after making code changes to verify correctness, or to understand existing issues in the codebase.\n\n" +
        "Example: diagnostics() - returns all errors/warnings\n" +
        "Example: diagnostics(changed_files=['src/foo.ts', 'src/bar.ts']) - filter to specific files",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          changed_files: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of workspace-relative file paths to filter diagnostics to.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch",
      description:
        "Fetch content from a URL. Any accessible URL is allowed.\n\n" +
        "Use this to retrieve API documentation, code examples, library READMEs, technical references, or any web content. " +
        "Maximum response size is 512KB, content will be truncated if larger.\n\n" +
        "Example: fetch(url='https://raw.githubusercontent.com/user/repo/main/README.md')",
      parameters: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            minLength: 1,
            description: "The URL to fetch. Must be from an allowed domain.",
          },
          max_size: {
            type: "number",
            minimum: 1024,
            maximum: 524288,
            description:
              "Optional maximum content size in bytes. Defaults to 512KB.",
          },
        },
      },
    },
  },
];

export type PlanningSessionPhase = "default";

const ALL_TOOL_NAMES = [
  "list_files",
  "read_file",
  "git_status",
  "git_diff",
  "grep",
  "glob",
  "propose_file_edit",
  "propose_apply_patch",
  "propose_shell",
  "task",
  "diagnostics",
  "fetch",
];

export function estimateRequestedArtifactCount(prompt: string): number {
  const normalized = prompt.trim();
  if (!normalized) {
    return 0;
  }

  // --- New pattern: Chinese numeral + "个文件" (e.g. "三个文件", "3个文件") ---
  const chineseNumWordMap: Record<string, number> = {
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const cnNumMatch = normalized.match(
    /([二两三四五六七八九十]|\d+)\s*个\s*文件/
  );
  if (cnNumMatch) {
    const raw = cnNumMatch[1];
    const parsed = chineseNumWordMap[raw] ?? Number(raw);
    if (parsed >= 2) return parsed;
  }

  // --- New pattern: English "<N> (separate|distinct|new)? files" ---
  const enNumMatch = normalized.match(
    /(\d+)\s+(?:separate\s+|distinct\s+|new\s+)?files?\b/i
  );
  if (enNumMatch) {
    const parsed = Number(enNumMatch[1]);
    if (parsed >= 2) return parsed;
  }

  // --- New pattern: split/enumeration with 、 (e.g. "拆分成HTML、CSS、JS") ---
  const splitMatch = normalized.match(/拆分[成为]?\s*(.+)/);
  if (splitMatch) {
    const tail = splitMatch[1];
    const parts = tail
      .split(/[、，,\s+和and]+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.length;
  }

  if (
    /(完整.{0,4}(前端|网页|页面)|完整的前端|完整前端|complete\s+(frontend|web\s*page)|full\s+(frontend|web\s*app))/i.test(
      normalized
    )
  ) {
    return 3;
  }

  const segments = normalized
    .split(/(?:\s+and\s+|\s+plus\s+|以及|并且|还有|和|，|,|；|;|、)/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const artifactPattern =
    /(?:\.py\b|\.html\b|\.css\b|\.js\b|\.jsx\b|\.ts\b|\.tsx\b|\.json\b|python|html|css|javascript|typescript|脚本|页面|网页|文件)/i;
  const explicitCount = segments.filter((segment) =>
    artifactPattern.test(segment)
  ).length;
  if (explicitCount > 0) {
    return explicitCount;
  }

  return artifactPattern.test(normalized) ? 1 : 0;
}

function collectPatchedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      if (diffMatch[1] && diffMatch[1] !== "/dev/null") {
        files.add(diffMatch[1]);
      }
      if (diffMatch[2] && diffMatch[2] !== "/dev/null") {
        files.add(diffMatch[2]);
      }
      continue;
    }

    const plusMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusMatch?.[1]) {
      files.add(plusMatch[1]);
    }
  }

  return Array.from(files);
}

function countPlannedArtifacts(actions: ActionProposal[]): number {
  const artifacts = new Set<string>();

  for (const action of actions) {
    if (action.type === "apply_patch") {
      const patchFiles = collectPatchedFiles(action.payload.patch);
      if (patchFiles.length > 0) {
        patchFiles.forEach((file) => artifacts.add(`file:${file}`));
        continue;
      }
    }

    artifacts.add(`action:${action.id}`);
  }

  return artifacts.size;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function detectPatchOperationKinds(patch: string): string[] {
  const kinds = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("new file mode ")) {
      kinds.add("create");
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      kinds.add("delete");
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      kinds.add("rename");
      continue;
    }
    if (line.startsWith("@@")) {
      kinds.add("modify");
    }
  }
  if (!kinds.size) {
    kinds.add("modify");
  }
  return Array.from(kinds).sort();
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function smartTruncateWithHint(
  text: string,
  limit: number,
  hint: string
): { text: string; truncated: boolean; hint?: string } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const truncatedText = smartTruncate(text, limit);
  return {
    text: truncatedText,
    truncated: true,
    hint,
  };
}

function stableMessageHashKey(
  messages: LiteLLMMessage[],
  workspacePath?: string
): string {
  const normalized = messages
    .map((m) => {
      const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
      const toolCallId = (m as any).tool_call_id
        ? String((m as any).tool_call_id)
        : "";
      const name = (m as any).name ? String((m as any).name) : "";
      return [m.role, m.content ?? "", toolCalls, toolCallId, name].join(
        "\u001f"
      );
    })
    .join("\u001e");
  const scope = workspacePath?.trim() ? `ws:${workspacePath.trim()}` : "ws:";
  return `${scope}:${hashText(normalized)}`;
}

const summaryCache = new SummaryCache({
  ttlMs: SUMMARY_CACHE_TTL_MS,
  maxEntries: SUMMARY_CACHE_MAX_ENTRIES,
});

// Cooldown is per workspace to reduce oscillation on retries.
const lastSummaryAtMsByWorkspace = new Map<string, number>();

function canSummarizeNow(workspacePath: string | undefined, currentTokens?: number): boolean {
  const ws = workspacePath?.trim() || "";
  if (!ws) return true;
  const last = lastSummaryAtMsByWorkspace.get(ws) ?? 0;
  // P2-2: Use dynamic cooldown based on token growth rate.
  const cooldown = computeDynamicCooldownMs(workspacePath, currentTokens ?? 0);
  return Date.now() - last >= cooldown;
}

function markSummarizedNow(workspacePath: string | undefined): void {
  const ws = workspacePath?.trim() || "";
  if (!ws) return;
  lastSummaryAtMsByWorkspace.set(ws, Date.now());
}


function selectToolDefinitions(toolNames: string[]): LiteLLMToolDefinition[] {
  const enabled = new Set(toolNames);
  return TOOL_DEFINITIONS.filter((tool) => enabled.has(tool.function.name));
}

/**
 * Build tool definitions tailored for a specific agent runtime.
 * The `task` tool's role enum is set to the agent's allowedSubAgents;
 * if the agent has no allowed sub-agents, `task` is excluded entirely.
 */
function buildAgentToolDefs(runtime: ResolvedAgentRuntime): LiteLLMToolDefinition[] {
  const allowedRoles = runtime.allowedSubAgents;
  return TOOL_DEFINITIONS.map((td) => {
    if (td.function.name !== "task") return td;
    if (allowedRoles.length === 0) return null;
    return {
      ...td,
      function: {
        ...td.function,
        parameters: {
          ...td.function.parameters,
          properties: {
            ...(td.function.parameters as any).properties,
            role: {
              ...(td.function.parameters as any).properties.role,
              enum: [...allowedRoles],
            },
          },
        },
      },
    };
  }).filter((td): td is LiteLLMToolDefinition => td !== null);
}

export class LocalOnlyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyPolicyError";
  }
}

export interface ToolCallEvent {
  type: "start" | "end";
  callId: string;
  toolName: string;
  argsPreview?: string;
  result?: "success" | "failed";
  resultPreview?: string;
}

export interface RunPlanningSessionInput {
  prompt: string;
  settings: AppSettings;
  /** Agent identifier or conversation binding. Determines system prompt, tool set, and sub-agent permissions. */
  agentId?: string | ConversationAgentBinding;
  phase?: PlanningSessionPhase;
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
  }>;
  isContinuation?: boolean;
  internalSystemNote?: string;
  blockedActionFingerprints?: string[];
  signal?: AbortSignal;
  onAssistantChunk?: (chunk: string) => void;
  onToolCallEvent?: (event: ToolCallEvent) => void;
  /** Called with the estimated context token count after each LLM turn (including tool results). */
  onContextUpdate?: (estimatedTokens: number) => void;
}

export interface PlanningSessionResult {
  assistantReply: string;
  plan: OrchestrationPlan;
  toolTrace: ToolExecutionTrace[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface RequestRecord {
  requestId: string;
  inputLength: number;
  outputLength: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ToolErrorCategory =
  | "validation"
  | "workspace"
  | "permission"
  | "timeout"
  | "allowlist"
  | "transport"
  | "guardrail"
  | "tool_not_found"
  | "unknown";

export interface ToolExecutionTrace {
  callId: string;
  name: string;
  arguments: string;
  startedAt: string;
  finishedAt: string;
  attempts: number;
  status: "success" | "failed";
  retried: boolean;
  errorCategory?: ToolErrorCategory;
  errorMessage?: string;
  resultPreview?: string;
}

function createRequestId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as Record<string, unknown>).type === "text" &&
          "text" in item &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, string>).text;
        }
        return "";
      })
      .join("");
  }

  return "";
}


// ---------------------------------------------------------------------------
// P1-2: Map-reduce summarization
// ---------------------------------------------------------------------------
// Instead of truncating combined content to 12000 chars, we split messages
// into chunks that each fit within SUMMARY_CHUNK_MAX_CHARS, summarize each
// chunk independently (Map), then combine the chunk summaries and produce
// a final reduced summary (Reduce).
//
// Reference: LangChain MapReduceChain pattern.
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = [
  "你是一个代码助手内置的上下文压缩引擎。你的任务是将冗长的对话历史压缩为高密度的摘要，保留对后续工作至关重要的事实与技术上下文。",
  "请使用高度结构化、简明扼要的语言（中文）输出，严格控制在 800 字以内，并包含以下部分：",
  "【核心目标】用户最初的需求是什么？",
  "【已完成变更】涉及哪些文件的修改？具体做了什么（给出关键函数或组件名）？",
  "【收集到的事实】发现的重要错误信息、项目的架构约束、特殊的配置结构等。",
  "【当前进展与下一步】任务停在哪里？接下来立即需要解决的是什么？",
].join("\n");

const CHUNK_SUMMARY_SYSTEM_PROMPT = [
  "你是一个代码助手内置的上下文压缩引擎。你的任务是将以下对话片段压缩为简洁的摘要要点。",
  "保留所有关键技术细节：文件名、函数名、错误信息、架构决策。",
  "使用简洁的中文输出，严格控制在 400 字以内。",
].join("\n");

function formatMessagesForSummary(msgs: LiteLLMMessage[]): string {
  return msgs
    .map((msg) => {
      const roleLabel =
        msg.role === "user"
          ? "用户"
          : msg.role === "assistant"
          ? "助手"
          : msg.role;
      // Safely extract text from multimodal content (content may be an array
      // of {type:"text", text:"..."} objects in some providers).
      const text = normalizeMessageContent(msg.content);
      return `[${roleLabel}] ${text}`;
    })
    .join("\n---\n");
}

function splitMessagesIntoChunks(
  messages: LiteLLMMessage[],
  maxCharsPerChunk: number,
): LiteLLMMessage[][] {
  const chunks: LiteLLMMessage[][] = [];
  let currentChunk: LiteLLMMessage[] = [];
  let currentChars = 0;

  for (const msg of messages) {
    const msgChars = (msg.content ?? "").length + 20; // +20 for role label overhead
    if (currentChunk.length > 0 && currentChars + msgChars > maxCharsPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }
    currentChunk.push(msg);
    currentChars += msgChars;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function summarizeSingleChunk(
  content: string,
  settings: AppSettings,
  systemPrompt: string,
): Promise<string | null> {
  const messages: LiteLLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];

  try {
    const requestBody = createLiteLLMRequestBody(messages, settings, {});
    const response = await postLiteLLMChatCompletions(settings, requestBody);
    const payload = JSON.parse(response.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (error) {
    console.warn(
      `[Context] summarizeSingleChunk 失败 | content.length=${content.length}`,
      error,
    );
    return null;
  }
}

async function requestSummary(
  messagesToSummarize: LiteLLMMessage[],
  settings: AppSettings,
  options?: {
    workspacePath?: string;
  }
): Promise<string> {
  const cacheKey = stableMessageHashKey(
    messagesToSummarize,
    options?.workspacePath
  );
  const cached = summaryCache.get(cacheKey);
  if (cached) {
    console.log(`[Context] 摘要命中缓存 (${messagesToSummarize.length} messages)`);
    return cached;
  }

  console.log(`[Context] 开始上下文摘要压缩 | ${messagesToSummarize.length} messages`);
  const sumT0 = performance.now();

  const combinedContent = formatMessagesForSummary(messagesToSummarize);

  // If content fits in a single chunk, use direct summarization (fast path).
  if (combinedContent.length <= SUMMARY_CHUNK_MAX_CHARS) {
    const result = await summarizeSingleChunk(
      combinedContent,
      settings,
      SUMMARY_SYSTEM_PROMPT,
    );
    if (result) {
      const elapsed = ((performance.now() - sumT0) / 1000).toFixed(2);
      console.log(`[Context] 摘要完成 (直接) | ${elapsed}s | ${result.length} chars`);
      summaryCache.set(cacheKey, result);
      return result;
    }
  } else {
    // P1-2: Map-Reduce — split into chunks, summarize each, then reduce.
    const chunks = splitMessagesIntoChunks(messagesToSummarize, SUMMARY_CHUNK_MAX_CHARS);
    console.log(`[Context] Map-Reduce 摘要: ${chunks.length} chunks`);

    // Map phase: summarize each chunk
    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = formatMessagesForSummary(chunks[i]);
      const chunkSummary = await summarizeSingleChunk(
        chunkContent,
        settings,
        CHUNK_SUMMARY_SYSTEM_PROMPT,
      );
      if (chunkSummary) {
        chunkSummaries.push(`[片段 ${i + 1}/${chunks.length}]\n${chunkSummary}`);
      } else {
        // Fallback: take first 500 chars of the chunk
        chunkSummaries.push(
          `[片段 ${i + 1}/${chunks.length}]\n${chunkContent.slice(0, 500)}...`,
        );
      }
    }

    // Reduce phase: combine chunk summaries into final summary.
    // When truncation is needed, keep the *latest* chunks (tail) because
    // recent context is more relevant for the model's next action.
    const combinedChunkSummaries = chunkSummaries.join("\n\n");
    const reducedContent =
      combinedChunkSummaries.length <= SUMMARY_CHUNK_MAX_CHARS
        ? combinedChunkSummaries
        : "(早期片段已省略)...\n" + combinedChunkSummaries.slice(-SUMMARY_CHUNK_MAX_CHARS);

    const finalSummary = await summarizeSingleChunk(
      `以下是对话历史分段摘要，请合并为一份完整、结构化的最终摘要：\n\n${reducedContent}`,
      settings,
      SUMMARY_SYSTEM_PROMPT,
    );

    if (finalSummary) {
      const elapsed = ((performance.now() - sumT0) / 1000).toFixed(2);
      console.log(
        `[Context] Map-Reduce 摘要完成 | ${elapsed}s | ${chunks.length} chunks → ${finalSummary.length} chars`,
      );
      summaryCache.set(cacheKey, finalSummary);
      return finalSummary;
    }
  }

  // Fallback when summarization fails
  const userMessages = messagesToSummarize.filter((m) => m.role === "user");
  const fallbackLines = userMessages
    .map((m) => m.content.slice(0, 100))
    .slice(0, 5);
  const fallback = `[自动摘要] 之前的对话包含 ${
    messagesToSummarize.length
  } 条消息。用户主要请求：${fallbackLines.join("；")}`;
  summaryCache.set(cacheKey, fallback);
  return fallback;
}

function normalizeConversationHistory(
  conversationHistory: RunPlanningSessionInput["conversationHistory"]
): LiteLLMMessage[] {
  if (!conversationHistory?.length) {
    return [];
  }

  return conversationHistory
    .filter(
      (message) =>
        message.content ||
        message.role === "tool" ||
        (message.role === "assistant" &&
          message.tool_calls &&
          message.tool_calls.length > 0)
    )
    .map((message) => {
      const m: LiteLLMMessage = {
        role: message.role as any,
        content: message.content.trim(),
      };
      if (message.tool_calls) {
        m.tool_calls = message.tool_calls;
      }
      if (message.role === "tool" && message.tool_call_id) {
        m.tool_call_id = message.tool_call_id;
      }
      if (message.role === "tool" && message.name) {
        m.name = message.name;
      }
      return m;
    });
}

function inputLengthOf(messages: LiteLLMMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function parseErrorMessage(raw: string, status: number): string {
  if (!raw.trim()) {
    return `${status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 240);
  } catch (_error) {
    return raw.slice(0, 240);
  }
}

function parseCompletionPayload(raw: string): ChatCompletionPayload {
  try {
    const parsed = JSON.parse(raw) as ChatCompletionPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("completion payload invalid");
    }
    return parsed;
  } catch (_error) {
    throw new Error("模型响应不是有效 JSON。");
  }
}

function parseToolCalls(raw: unknown): { parsed: ToolCallRecord[]; droppedCount: number } {
  if (!Array.isArray(raw)) {
    return { parsed: [], droppedCount: 0 };
  }

  let dropped = 0;
  const parsed = raw
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        dropped += 1;
        return null;
      }
      const record = item as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") {
        dropped += 1;
        return null;
      }
      const fnRecord = fn as Record<string, unknown>;
      if (
        typeof fnRecord.name !== "string" ||
        typeof fnRecord.arguments !== "string" ||
        !fnRecord.name.trim() ||
        !fnRecord.arguments.trim()
      ) {
        dropped += 1;
        return null;
      }
      const id =
        typeof record.id === "string" && record.id.trim()
          ? record.id
          : `toolcall-${index + 1}-${Date.now()}`;
      return {
        id,
        type: "function" as const,
        function: {
          name: fnRecord.name.trim(),
          arguments: fnRecord.arguments.trim(),
        },
      };
    })
    .filter((item): item is ToolCallRecord => Boolean(item));
  return { parsed, droppedCount: dropped };
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Strip line-number prefixes that read_file adds (e.g. "487│  code" → "  code").
 * Models may accidentally copy these into search/anchor fields.
 */
function stripLineNumberPrefixes(text: string): string {
  return text.replace(/^[0-9]+│/gm, "");
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function countOccurrences(content: string, snippet: string): number {
  if (!snippet) {
    return 0;
  }

  let total = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(snippet, offset);
    if (index < 0) {
      break;
    }
    total += 1;
    offset = index + Math.max(1, snippet.length);
  }
  return total;
}

function splitPatchLines(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  if (!content.length) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;

  return {
    lines: body.length > 0 ? body.split("\n") : [""],
    hasTrailingNewline,
  };
}

function splitContentSegments(content: string): string[] {
  if (!content.length) {
    return [];
  }

  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      segments.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) {
    segments.push(content.slice(start));
  }
  return segments;
}

function replaceByLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位编辑。");
  }
  if (startLine < 1 || endLine < 1 || startLine > endLine) {
    throw new Error("非法行号范围。");
  }
  if (startLine > segments.length || endLine > segments.length) {
    throw new Error(`行号超出文件范围（总行数 ${segments.length}）。`);
  }

  return (
    segments.slice(0, startLine - 1).join("") +
    replacement +
    segments.slice(endLine).join("")
  );
}

function insertByLine(
  content: string,
  line: number,
  insertContent: string,
  position: "before" | "after"
): string {
  const segments = splitContentSegments(content);
  if (!segments.length) {
    throw new Error("文件为空，无法按行定位插入。");
  }
  if (line < 1 || line > segments.length) {
    throw new Error(`line 超出文件范围（总行数 ${segments.length}）。`);
  }

  const insertionIndex = position === "before" ? line - 1 : line;
  return (
    segments.slice(0, insertionIndex).join("") +
    insertContent +
    segments.slice(insertionIndex).join("")
  );
}

function formatUnifiedRange(start: number, count: number): string {
  if (count === 1) {
    return `${start}`;
  }
  return `${start},${count}`;
}

function buildReplacementPatch(
  relativePath: string,
  before: string,
  after: string
): string {
  if (before === after) {
    throw new Error("编辑结果为空，未产生文件变更。");
  }

  const previous = splitPatchLines(before);
  const next = splitPatchLines(after);
  const previousCount = previous.lines.length;
  const nextCount = next.lines.length;
  const previousStart = previousCount > 0 ? 1 : 0;
  const nextStart = nextCount > 0 ? 1 : 0;
  const hunkLines: string[] = [];

  for (const line of previous.lines) {
    hunkLines.push(`-${line}`);
  }
  if (previous.lines.length > 0 && !previous.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  for (const line of next.lines) {
    hunkLines.push(`+${line}`);
  }
  if (next.lines.length > 0 && !next.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  return (
    [
      `diff --git a/${relativePath} b/${relativePath}`,
      `--- a/${relativePath}`,
      `+++ b/${relativePath}`,
      `@@ -${formatUnifiedRange(
        previousStart,
        previousCount
      )} +${formatUnifiedRange(nextStart, nextCount)} @@`,
      ...hunkLines,
    ].join("\n") + "\n"
  );
}

function buildCreateFilePatch(relativePath: string, content: string): string {
  const next = splitPatchLines(content);
  if (next.lines.length < 1) {
    throw new Error("create 操作要求 content 至少包含一行。");
  }

  const hunkLines = next.lines.map((line) => `+${line}`);
  if (!next.hasTrailingNewline) {
    hunkLines.push("\\ No newline at end of file");
  }

  return (
    [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +${formatUnifiedRange(1, next.lines.length)} @@`,
      ...hunkLines,
    ].join("\n") + "\n"
  );
}

function createActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function classifyToolError(message: string): ToolErrorCategory {
  const lower = message.toLowerCase();
  if (
    lower.includes("不能为空") ||
    lower.includes("invalid json") ||
    lower.includes("arguments") ||
    lower.includes("未找到") ||
    lower.includes("出现多次") ||
    lower.includes("预检失败") ||
    lower.includes("已存在") ||
    lower.includes("未产生文件变更") ||
    lower.includes("不支持的 file edit") ||
    lower.includes("行号") ||
    lower.includes("文件为空") ||
    lower.includes("invalid target path") ||
    lower.includes("no such file or directory") ||
    lower.includes("line 超出")
  ) {
    return "validation";
  }
  if (lower.includes("未选择工作区") || lower.includes("workspace")) {
    return "workspace";
  }
  if (
    lower.includes("allowlist") ||
    lower.includes("guardrail") ||
    lower.includes("shell 控制符") ||
    lower.includes("工作区越界路径") ||
    lower.includes("受限目录") ||
    lower.includes("命中被禁止的可执行程序") ||
    lower.includes("命中高风险关键字") ||
    lower.includes("解释器内联执行") ||
    lower.includes("propose_apply_patch") ||
    lower.includes("直接改文件")
  ) {
    return "guardrail";
  }
  if (
    lower.includes("patch does not apply") ||
    lower.includes("corrupt patch")
  ) {
    return "validation";
  }
  if (lower.includes("timed out") || lower.includes("超时")) {
    return "timeout";
  }
  if (lower.includes("permission") || lower.includes("not permitted")) {
    return "permission";
  }
  if (lower.includes("未知工具")) {
    return "tool_not_found";
  }
  if (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("http")
  ) {
    return "transport";
  }
  return "unknown";
}

function shouldRetryToolCall(category: ToolErrorCategory): boolean {
  return category === "transport" || category === "timeout";
}
function resultPreview(content: string): string {
  return content.slice(0, MAX_TOOL_RESULT_PREVIEW);
}

/**
 * Generate a short human-readable preview of tool call arguments.
 */
function summarizeToolArgs(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    switch (toolName) {
      case "read_file":
        return String(args.relative_path || "");
      case "list_files":
        return String(args.relative_path || "/");
      case "grep":
        return `"${String(args.pattern || "").slice(0, 30)}"${args.include_glob ? ` in ${args.include_glob}` : ""}`;
      case "glob":
        return String(args.pattern || "").slice(0, 40);
      case "git_status":
        return "";
      case "git_diff":
        return args.file_path ? String(args.file_path) : "(all)";
      case "propose_file_edit":
        return String(args.relative_path || "");
      case "propose_apply_patch": {
        const patch = String(args.patch || "");
        const match = patch.match(/^diff --git a\/(.+?) b\//m);
        return match ? match[1] : "(patch)";
      }
      case "propose_shell": {
        const cmd = String(args.shell || "");
        return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
      }
      case "task":
        return `${args.role}: ${String(args.description || "").slice(0, 30)}...`;
      case "diagnostics":
        return args.changed_files ? `${(args.changed_files as string[]).length} files` : "(all)";
      case "fetch":
        return String(args.url || "").slice(0, 50);
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function limitJsonField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[truncated]";
}

function trimToolContentForContext(toolName: string, jsonText: string): string {
  // Tool content is JSON string. We structurally trim heavy fields per tool.
  try {
    const obj = JSON.parse(jsonText) as Record<string, any>;

    if (toolName === "read_file") {
      if (typeof obj.content_preview === "string") {
        obj.content_preview = limitJsonField(
          obj.content_preview,
          MAX_TOOL_OUTPUT_CHARS
        );
      }
      // Keep hint/metadata; never include any full raw file contents field.
    }

    if (toolName === "grep") {
      if (typeof obj.matches_preview === "string") {
        obj.matches_preview = limitJsonField(
          obj.matches_preview,
          MAX_GREP_PREVIEW_CHARS
        );
      }
      if (
        typeof obj.match_count === "number" &&
        obj.match_count > MAX_GREP_PREVIEW_MATCHES
      ) {
        obj.note = `matches_preview 已限制为前 ${MAX_GREP_PREVIEW_MATCHES} 条，并做了字符裁剪。`;
      }
    }

    if (toolName === "glob") {
      if (typeof obj.files_preview === "string") {
        obj.files_preview = limitJsonField(
          obj.files_preview,
          MAX_GLOB_PREVIEW_CHARS
        );
      }
      if (
        typeof obj.file_count === "number" &&
        obj.file_count > MAX_GLOB_PREVIEW_FILES
      ) {
        obj.note = `files_preview 已限制为前 ${MAX_GLOB_PREVIEW_FILES} 条，并做了字符裁剪。`;
      }
    }

    if (toolName === "diagnostics") {
      // diagnostics tool already aggregates; just cap preview.
      if (typeof obj.diagnostics_preview === "string") {
        obj.diagnostics_preview = limitJsonField(
          obj.diagnostics_preview,
          MAX_TOOL_OUTPUT_CHARS
        );
      }
    }

    if (toolName === "fetch") {
      if (typeof obj.content_preview === "string") {
        obj.content_preview = limitJsonField(
          obj.content_preview,
          MAX_FETCH_PREVIEW_CHARS
        );
      }
    }

    const stringified = JSON.stringify(obj);
    if (stringified.length <= MAX_TOOL_OUTPUT_CHARS) {
      return stringified;
    }

    // Absolute hard cap
    const hard = smartTruncateWithHint(
      stringified,
      MAX_TOOL_OUTPUT_CHARS,
      `tool(${toolName}) 输出过长，已做硬裁剪。`
    );
    return hard.text;
  } catch {
    // Not JSON or parse failed: fallback to char cap
    const hard = smartTruncateWithHint(
      jsonText,
      MAX_TOOL_OUTPUT_CHARS,
      `tool(${toolName}) 输出过长，已做硬裁剪。`
    );
    return hard.text;
  }
}

function renderListEntries(entries: FileEntry[]): string {
  const sorted = [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const preview = sorted.slice(0, MAX_LIST_ENTRIES).map((entry) => {
    if (entry.is_dir) {
      return `[DIR] ${entry.name}/`;
    }
    return `[FILE] ${entry.name} (${entry.size}B)`;
  });
  if (sorted.length > MAX_LIST_ENTRIES) {
    preview.push(`... ${sorted.length - MAX_LIST_ENTRIES} entries omitted`);
  }
  return preview.join("\n");
}

const SUB_AGENT_MAX_TURNS_DEFAULT = 20;

interface SubAgentResult {
  reply: string;
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
  turnCount: number;
  structuredOutput?: StructuredSubAgentOutput;
}

async function executeSubAgentTask(
  role: string,
  taskDescription: string,
  workspacePath: string,
  settings: AppSettings,
  toolPermissions: ToolPermissions,
  workingMemory?: WorkingMemory,
): Promise<SubAgentResult> {
  const agentDef = DEFAULT_AGENTS.find(
    (agent) => agent.role === role && agent.allowAsSubAgent
  );
  if (!agentDef) {
    return {
      reply: `角色 "${role}" 不可用作 Sub-Agent。`,
      proposedActions: [],
      toolTrace: [],
      turnCount: 0,
    };
  }

  const maxTurns = agentDef.subAgentMaxTurns ?? SUB_AGENT_MAX_TURNS_DEFAULT;
  const subAgentTools = selectToolDefinitions(
    agentDef.tools.filter((toolName) => toolName !== "task")
  );

  // Compute context budgets for sub-agent
  const limitTokens = settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000;
  const outputBufferTokens = Math.min(8000, Math.max(512, Math.floor(limitTokens * 0.15)));
  const hardPromptBudget = Math.max(0, limitTokens - outputBufferTokens);
  const softPromptBudget = Math.floor(hardPromptBudget * 0.9);
  const promptBudgetTarget = softPromptBudget > 0 ? softPromptBudget : hardPromptBudget;

  // Inject shared Working Memory context (at most 15% of token budget)
  const memoryContext = workingMemory
    ? serializeWorkingMemory(
        workingMemory,
        Math.floor(promptBudgetTarget * 0.15),
        role as SubAgentRole,
      )
    : "";

  const subAgentSystemPrompt = [
    `你是 Cofree 的 ${agentDef.displayName} Sub-Agent。`,
    `你的专长：${agentDef.promptIntent}`,
    `当前工作区: ${workspacePath}`,
    memoryContext ? `\n## 已知上下文\n${memoryContext}` : "",
    "你正在执行一个被委派的子任务。请专注于完成任务并返回结果。",
    "完成任务后，请简洁地汇报结果。不要提出超出任务范围的额外建议。",
    "严禁输出伪工具调用标签。回复语言与任务描述保持一致。",
    agentDef.outputSchemaHint ? `\n${agentDef.outputSchemaHint}` : "",
  ].filter(Boolean).join("\n");

  const messages: LiteLLMMessage[] = [
    { role: "system", content: subAgentSystemPrompt },
    { role: "user", content: taskDescription },
  ];

  const proposedActions: ActionProposal[] = [];
  const toolTrace: ToolExecutionTrace[] = [];
  let subToolNotFoundStrikes = 0;
  let subConsecutiveFailureTurns = 0;

  // P0-2: Include tool definition overhead for sub-agent.
  const subToolDefTokens = estimateTokensForToolDefinitions(subAgentTools);
  const compressionPolicy = {
    maxPromptTokens: promptBudgetTarget,
    minMessagesToSummarize: MIN_MESSAGES_TO_SUMMARIZE,
    minRecentMessagesToKeep: MIN_RECENT_MESSAGES_TO_KEEP,
    recentTokensMinRatio: RECENT_TOKENS_MIN_RATIO,
    toolMessageMaxChars: TOOL_MESSAGE_MAX_CHARS,
    mergeToolMessages: true,
    toolDefinitionTokens: subToolDefTokens,
  };
  const summarizer = {
    canSummarize: () => {
      const estTokens = estimateTokensForMessages(messages);
      return canSummarizeNow(workspacePath, estTokens);
    },
    summarize: (messagesToSummarize: LiteLLMMessage[]) =>
      requestSummary(messagesToSummarize, settings, { workspacePath }),
    markSummarized: () => markSummarizedNow(workspacePath),
  };
  const pinnedPrefixLen = 2;

  console.log(`[SubAgent] 启动 | role=${role} | maxTurns=${maxTurns} | tools=${subAgentTools.length}`);

  for (let turn = 0; turn < maxTurns; turn += 1) {
    console.log(`[SubAgent] ── Turn ${turn + 1}/${maxTurns} ── messages=${messages.length}`);

    const compression = await compressMessagesToFitBudget({
      messages,
      policy: compressionPolicy,
      summarizer,
      pinnedPrefixLen,
    });
    if (compression.compressed && compression.messages !== messages) {
      const beforeLen = messages.length;
      messages.splice(0, messages.length, ...compression.messages);
      console.log(`[SubAgent] 上下文压缩: ${beforeLen} → ${messages.length} messages`);
    }


    const completion = await requestToolCompletion(
      messages,
      settings,
      subAgentTools
    );
    messages.push(completion.assistantMessage);

    // P1-3: Calibrate token estimates from sub-agent API responses (per-model).
    if (completion.requestRecord.inputTokens) {
      const estBeforeCall = estimateTokensForMessages(messages) + subToolDefTokens;
      updateTokenCalibration(estBeforeCall, completion.requestRecord.inputTokens, settings.model);
    }

    if (!completion.toolCalls.length) {
      if (completion.droppedToolCalls > 0) {
        console.warn(`[SubAgent] ${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃`);
        messages.push({
          role: "system",
          content: `系统提示：${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃。请使用正确格式重试。`,
        });
        continue;
      }
      console.log(`[SubAgent] 完成 | turns=${turn + 1}`);
      const finalReply = completion.assistantMessage.content.trim();
      const structuredOutput = tryExtractStructuredOutput(role as SubAgentRole, finalReply);
      if (structuredOutput) {
        console.log(`[SubAgent] 提取到结构化输出 | role=${structuredOutput.role}`);
      }
      return {
        reply: finalReply,
        proposedActions,
        toolTrace,
        turnCount: turn + 1,
        structuredOutput,
      };
    }

    const subToolNames = completion.toolCalls.map((tc) => tc.function.name);
    console.log(`[SubAgent] Turn ${turn + 1} 收到 ${completion.toolCalls.length} 个工具调用: [${subToolNames.join(", ")}]`);

    let subTurnHasToolNotFound = false;
    let subTurnSuccessCount = 0;
    let subTurnFailureCount = 0;
    for (const toolCall of completion.toolCalls) {
      const subToolT0 = performance.now();
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        workspacePath,
        toolPermissions,
        settings,
        undefined,
        [],
        agentDef.tools,
      );
      const subToolMs = (performance.now() - subToolT0).toFixed(0);
      console.log(
        `[SubAgent][Tool] ${toolCall.function.name} → ${trace.status} | ${subToolMs}ms` +
          (trace.status === "failed" ? ` | ${trace.errorMessage}` : "")
      );
      toolTrace.push(trace);

      if (toolResult.success === false) {
        subTurnFailureCount += 1;
        if (toolResult.errorCategory === "tool_not_found") {
          subTurnHasToolNotFound = true;
        }
      } else {
        subTurnSuccessCount += 1;
        // Feed successful tool results back into shared Working Memory
        if (workingMemory) {
          try {
            const parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
            const knowledge = extractFileKnowledge(
              toolCall.function.name,
              parsedArgs,
              toolResult.content,
              role,
            );
            if (knowledge) {
              workingMemory.fileKnowledge.set(knowledge.relativePath, knowledge);
            }
          } catch {
            // Ignore parse errors for working memory extraction
          }
        }
      }

      if (toolResult.proposedAction) {
        proposedActions.push(toolResult.proposedAction);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: trimToolContentForContext(
          toolCall.function.name,
          toolResult.content
        ),
      });
    }

    // --- Circuit breaker: tool_not_found ---
    if (subTurnHasToolNotFound) {
      subToolNotFoundStrikes += 1;
    } else {
      subToolNotFoundStrikes = 0;
    }
    if (subToolNotFoundStrikes >= MAX_TOOL_NOT_FOUND_STRIKES) {
      console.warn(`[SubAgent] 熔断: tool_not_found 连续 ${subToolNotFoundStrikes} 轮`);
      return {
        reply: "Sub-Agent 多次调用不存在的工具，已自动终止。",
        proposedActions,
        toolTrace,
        turnCount: turn + 1,
      };
    }
    if (subToolNotFoundStrikes > 0) {
      const subToolNames = subAgentTools.map((t) => t.function.name);
      messages.push({
        role: "system",
        content: [
          `系统提示：你调用了不存在的工具（连续 ${subToolNotFoundStrikes} 轮）。`,
          `你只能使用以下工具: [${subToolNames.join(", ")}]`,
          "请严格从上述列表中选择工具，不要臆造工具名称。",
        ].join("\n"),
      });
    }

    // --- Circuit breaker: consecutive all-failure turns ---
    if (subTurnSuccessCount === 0 && subTurnFailureCount > 0) {
      subConsecutiveFailureTurns += 1;
    } else {
      subConsecutiveFailureTurns = 0;
    }
    if (subConsecutiveFailureTurns >= MAX_CONSECUTIVE_FAILURE_TURNS) {
      console.warn(`[SubAgent] 熔断: 连续 ${subConsecutiveFailureTurns} 轮全部失败`);
      return {
        reply: "Sub-Agent 连续多轮工具调用全部失败，已自动终止。",
        proposedActions,
        toolTrace,
        turnCount: turn + 1,
      };
    }
  }

  console.warn(`[SubAgent] 达到轮次上限 (${maxTurns})，强制返回`);
  return {
    reply: "Sub-Agent 达到工具调用轮次上限，已返回当前进度。",
    proposedActions,
    toolTrace,
    turnCount: maxTurns,
  };
}

interface DiagnosticEntry {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
}

interface DiagnosticsResult {
  success: boolean;
  diagnostics: DiagnosticEntry[];
  tool_used: string;
  raw_output: string;
}

async function fetchPostPatchDiagnostics(
  workspacePath: string,
  changedFiles: string[]
): Promise<{ hasDiagnostics: boolean; summary: string }> {
  try {
    const result = await invoke<DiagnosticsResult>(
      "get_workspace_diagnostics",
      {
        workspacePath,
        changedFiles,
      }
    );
    if (
      !result.success ||
      result.tool_used === "none" ||
      result.diagnostics.length === 0
    ) {
      return { hasDiagnostics: false, summary: "" };
    }
    const relevantDiagnostics = result.diagnostics.slice(0, 10);
    const lines = relevantDiagnostics.map(
      (d) =>
        `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${
          d.message
        }`
    );
    const summary = `[诊断反馈 via ${result.tool_used}] 发现 ${
      result.diagnostics.length
    } 个问题:\n${lines.join("\n")}`;
    return { hasDiagnostics: true, summary };
  } catch {
    return { hasDiagnostics: false, summary: "" };
  }
}

async function executeToolCall(
  call: ToolCallRecord,
  workspacePath: string,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  allowedSubAgents?: SubAgentRole[],
  enabledToolNames?: string[],
  workingMemory?: WorkingMemory,
): Promise<ToolExecutionResult> {
  const safeWorkspace = workspacePath.trim();
  if (!safeWorkspace) {
    const message = "未选择工作区。";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "workspace",
      errorMessage: message,
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (_error) {
    const message = "tool arguments 不是合法 JSON";
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: "validation",
      errorMessage: message,
    };
  }

  try {
    if (call.function.name === "list_files") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const ignorePatterns =
        projectConfig?.ignorePatterns && projectConfig.ignorePatterns.length > 0
          ? projectConfig.ignorePatterns
          : null;
      const entries = await invoke<FileEntry[]>("list_workspace_files", {
        workspacePath: safeWorkspace,
        relativePath,
        ignorePatterns,
      });
      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          entry_count: entries.length,
          entries_preview: renderListEntries(entries),
        }),
        success: true,
      };
    }

    if (call.function.name === "read_file") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const result = await invoke<{
        content: string;
        total_lines: number;
        start_line: number;
        end_line: number;
      }>("read_workspace_file", {
        workspacePath: safeWorkspace,
        relativePath,
        startLine,
        endLine,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
          projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });

      // Add line numbers to content for model orientation
      const lines = result.content.split("\n");
      // Remove trailing empty line from split if content ends with \n
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      const numbered = lines
        .map((line, i) => `${result.start_line + i}│${line}`)
        .join("\n");
      const trimmed = smartTruncate(numbered, MAX_FILE_PREVIEW_CHARS);
      const wasTruncated = numbered.length > MAX_FILE_PREVIEW_CHARS;

      return {
        content: JSON.stringify({
          ok: true,
          relative_path: relativePath,
          total_lines: result.total_lines,
          showing_lines: `${result.start_line}-${result.end_line}`,
          content_preview: trimmed,
          truncated: wasTruncated,
          ...(wasTruncated
            ? {
                hint: `文件共 ${result.total_lines} 行，当前内容被截断。请用 start_line/end_line 分段读取剩余部分。`,
              }
            : {}),
        }),
        success: true,
      };
    }

    if (call.function.name === "git_status") {
      const status = await invoke<{
        modified: string[];
        added: string[];
        deleted: string[];
        untracked: string[];
      }>("git_status_workspace", {
        workspacePath: safeWorkspace,
      });
      return {
        content: JSON.stringify({
          ok: true,
          ...status,
        }),
        success: true,
      };
    }

    if (call.function.name === "git_diff") {
      const filePath = normalizeRelativePath(args.file_path);
      const diff = await invoke<string>("git_diff_workspace", {
        workspacePath: safeWorkspace,
        filePath: filePath || null,
      });
      return {
        content: JSON.stringify({
          ok: true,
          file_path: filePath || null,
          diff_preview: smartTruncate(diff, MAX_FILE_PREVIEW_CHARS),
          truncated: diff.length > MAX_FILE_PREVIEW_CHARS,
        }),
        success: true,
      };
    }

    if (call.function.name === "grep") {
      const pattern = asString(args.pattern).trim();
      if (!pattern) {
        const message = "pattern 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const includeGlob = asString(args.include_glob).trim() || null;
      const maxResults = normalizeOptionalPositiveInt(args.max_results) ?? 50;
      const result = await invoke<{
        matches: Array<{ file: string; line: number; content: string }>;
        truncated: boolean;
      }>("grep_workspace_files", {
        workspacePath: safeWorkspace,
        pattern,
        includeGlob,
        maxResults,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
          projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });
      const matchCount = result.matches.length;
      const preview = result.matches
        .slice(0, 30)
        .map((m) => `${m.file}:${m.line}│${m.content}`)
        .join("\n");
      return {
        content: JSON.stringify({
          ok: true,
          pattern,
          include_glob: includeGlob,
          match_count: matchCount,
          truncated: result.truncated,
          matches_preview: smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
        }),
        success: true,
      };
    }

    if (call.function.name === "glob") {
      const pattern = asString(args.pattern).trim();
      if (!pattern) {
        const message = "pattern 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const maxResults = normalizeOptionalPositiveInt(args.max_results) ?? 100;
      const entries = await invoke<
        Array<{ path: string; size: number; modified: number }>
      >("glob_workspace_files", {
        workspacePath: safeWorkspace,
        pattern,
        maxResults,
        ignorePatterns:
          projectConfig?.ignorePatterns &&
          projectConfig.ignorePatterns.length > 0
            ? projectConfig.ignorePatterns
            : null,
      });
      const preview = entries
        .slice(0, 60)
        .map((e) => `${e.path} (${e.size}B)`)
        .join("\n");
      return {
        content: JSON.stringify({
          ok: true,
          pattern,
          file_count: entries.length,
          files_preview: smartTruncate(preview, MAX_FILE_PREVIEW_CHARS),
        }),
        success: true,
      };
    }

    if (call.function.name === "propose_apply_patch") {
      const patch = asString(args.patch).trim();
      if (!patch) {
        const message = "patch 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const preflight = await invoke<PatchApplyResult>(
        "check_workspace_patch",
        {
          workspacePath: safeWorkspace,
          patch,
        }
      );
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (toolPermissions.propose_apply_patch === "auto") {
        const snapshot = await invoke<{
          success: boolean;
          snapshot_id: string;
          files: string[];
        }>("create_workspace_snapshot", {
          workspacePath: safeWorkspace,
          patch,
        });
        const applyResult = await invoke<PatchApplyResult>(
          "apply_workspace_patch",
          { workspacePath: safeWorkspace, patch }
        );
        if (!applyResult.success && snapshot.success) {
          await invoke<PatchApplyResult>("restore_workspace_snapshot", {
            workspacePath: safeWorkspace,
            snapshotId: snapshot.snapshot_id,
          });
        }
        const responsePayload: Record<string, unknown> = {
          ok: applyResult.success,
          action_type: "apply_patch",
          auto_executed: true,
          patch_length: patch.length,
          files: applyResult.files,
          message: applyResult.message,
        };
        if (applyResult.success) {
          const diagnostics = await fetchPostPatchDiagnostics(
            safeWorkspace,
            applyResult.files
          );
          if (diagnostics.hasDiagnostics) {
            responsePayload.diagnostics = diagnostics.summary;
          }
        }
        return {
          content: JSON.stringify(responsePayload),
          success: applyResult.success,
          errorCategory: applyResult.success ? undefined : "validation",
          errorMessage: applyResult.success ? undefined : applyResult.message,
        };
      }

      const actionBase: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        toolCallId: call.id,
        toolName: call.function.name,
        type: "apply_patch",
        description: asString(
          args.description,
          "Apply generated patch to workspace (Gate A)"
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch,
        },
      };
      const action: ActionProposal = {
        ...actionBase,
        fingerprint: actionFingerprint(actionBase),
      };
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "propose_file_edit") {
      const relativePath = normalizeRelativePath(args.relative_path);
      const operationRaw = asString(args.operation, "replace")
        .trim()
        .toLowerCase();
      const operation = operationRaw || "replace";
      const applyAll = asBoolean(
        args.apply_all,
        asBoolean(args.replace_all, false)
      );
      const positionCandidate = asString(args.position, "after")
        .trim()
        .toLowerCase();
      const insertPosition =
        positionCandidate === "before" ? "before" : "after";
      const line = normalizeOptionalPositiveInt(args.line);
      const startLine = normalizeOptionalPositiveInt(args.start_line);
      const endLine = normalizeOptionalPositiveInt(args.end_line);
      if (!relativePath) {
        const message = "relative_path 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      let patch = "";
      const responseMeta: Record<string, unknown> = {
        mode: "file_edit",
        operation,
        relative_path: relativePath,
        apply_all: applyAll,
      };
      if (line) {
        responseMeta.line = line;
      }
      if (startLine) {
        responseMeta.start_line = startLine;
      }
      if (endLine) {
        responseMeta.end_line = endLine;
      }

      if (endLine && !startLine) {
        const message = "提供 end_line 时必须同时提供 start_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (startLine && endLine && startLine > endLine) {
        const message = "start_line 不能大于 end_line";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      if (operation === "create") {
        const createContent = asString(args.content, asString(args.replace));
        const overwrite = asBoolean(args.overwrite, false);
        if (!createContent) {
          const message = "create 操作要求 content 非空";
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        let existingContent: string | null = null;
        try {
          existingContent = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: safeWorkspace,
              relativePath,
            })
          ).content;
        } catch (_error) {
          existingContent = null;
        }

        if (existingContent !== null && !overwrite) {
          const message = `目标文件已存在: ${relativePath}（如需覆盖请设置 overwrite=true）`;
          return {
            content: JSON.stringify({ error: message }),
            success: false,
            errorCategory: "validation",
            errorMessage: message,
          };
        }

        patch =
          existingContent === null
            ? buildCreateFilePatch(relativePath, createContent)
            : buildReplacementPatch(
                relativePath,
                existingContent,
                createContent
              );
        responseMeta.created = existingContent === null;
        responseMeta.overwrite = overwrite;
      } else {
        let original = "";
        let fileExists = true;
        try {
          original = (
            await invoke<{
              content: string;
              total_lines: number;
              start_line: number;
              end_line: number;
            }>("read_workspace_file", {
              workspacePath: safeWorkspace,
              relativePath,
            })
          ).content;
        } catch (_readError) {
          fileExists = false;
          // File doesn't exist — auto-detect as create intent
          const createContent = asString(args.content, asString(args.replace));
          if (createContent) {
            patch = buildCreateFilePatch(relativePath, createContent);
            responseMeta.auto_create = true;
            responseMeta.operation = "create";
          } else {
            const message = `文件不存在: ${relativePath}。若要创建新文件，请使用 operation='create' 并提供 content 参数`;
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message,
            };
          }
        }
        if (!patch && fileExists) {
          let nextContent = original;

          if (operation === "replace") {
            if (startLine) {
              const replacement = asString(
                args.content,
                asString(args.replace)
              );
              nextContent = replaceByLineRange(
                original,
                startLine,
                endLine ?? startLine,
                replacement
              );
              responseMeta.selection_mode = "line_range";
            } else {
              const search = stripLineNumberPrefixes(asString(args.search));
              const replace = asString(args.replace);
              if (!search) {
                const message =
                  "replace 操作要求 search 非空，或提供 start_line/end_line。若要创建新文件，请改用 operation='create' 并提供 content 参数";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, search);
              if (hits < 1) {
                const message = `search 片段未找到: ${relativePath}`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              nextContent = applyAll
                ? original.split(search).join(replace)
                : original.replace(search, replace);
              responseMeta.matched = hits;
            }
          } else if (operation === "insert") {
            const insertContent = asString(
              args.content,
              asString(args.replace)
            );
            if (!insertContent) {
              const message = "insert 操作要求 content 非空";
              return {
                content: JSON.stringify({ error: message }),
                success: false,
                errorCategory: "validation",
                errorMessage: message,
              };
            }
            if (line) {
              nextContent = insertByLine(
                original,
                line,
                insertContent,
                insertPosition
              );
              responseMeta.selection_mode = "line_anchor";
              responseMeta.position = insertPosition;
            } else {
              const anchor = stripLineNumberPrefixes(
                asString(args.anchor, asString(args.search))
              );
              if (!anchor) {
                const message = "insert 操作要求 anchor 非空，或提供 line";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, anchor);
              if (hits < 1) {
                const message = `anchor 片段未找到: ${relativePath}`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `anchor 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              const anchored =
                insertPosition === "before"
                  ? `${insertContent}${anchor}`
                  : `${anchor}${insertContent}`;
              nextContent = applyAll
                ? original.split(anchor).join(anchored)
                : original.replace(anchor, anchored);
              responseMeta.matched = hits;
              responseMeta.position = insertPosition;
            }
          } else if (operation === "delete") {
            if (startLine) {
              nextContent = replaceByLineRange(
                original,
                startLine,
                endLine ?? startLine,
                ""
              );
              responseMeta.selection_mode = "line_range";
            } else {
              const search = stripLineNumberPrefixes(
                asString(args.search, asString(args.anchor))
              );
              if (!search) {
                const message =
                  "delete 操作要求 search 非空，或提供 start_line/end_line。若目标是删除整个文件，请改用 propose_run_command 执行 rm <relative_path>。";
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              const hits = countOccurrences(original, search);
              if (hits < 1) {
                const message = `search 片段未找到: ${relativePath}`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }
              if (!applyAll && hits > 1) {
                const message = `search 片段出现多次（${hits} 次）；请提供更精确片段或设置 apply_all=true`;
                return {
                  content: JSON.stringify({ error: message }),
                  success: false,
                  errorCategory: "validation",
                  errorMessage: message,
                };
              }

              nextContent = applyAll
                ? original.split(search).join("")
                : original.replace(search, "");
              responseMeta.matched = hits;
            }
          } else {
            const message = `不支持的 file edit operation: ${operation}`;
            return {
              content: JSON.stringify({ error: message }),
              success: false,
              errorCategory: "validation",
              errorMessage: message,
            };
          }

          patch = buildReplacementPatch(relativePath, original, nextContent);
        } // end if (!patch && fileExists)
      }

      const preflight = await invoke<PatchApplyResult>(
        "check_workspace_patch",
        {
          workspacePath: safeWorkspace,
          patch,
        }
      );
      if (!preflight.success) {
        const message = `Patch 预检失败: ${preflight.message}`;
        return {
          content: JSON.stringify({
            error: message,
            files: preflight.files,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }

      if (toolPermissions.propose_file_edit === "auto") {
        const snapshot = await invoke<{
          success: boolean;
          snapshot_id: string;
          files: string[];
        }>("create_workspace_snapshot", {
          workspacePath: safeWorkspace,
          patch,
        });
        const applyResult = await invoke<PatchApplyResult>(
          "apply_workspace_patch",
          { workspacePath: safeWorkspace, patch }
        );
        if (!applyResult.success && snapshot.success) {
          await invoke<PatchApplyResult>("restore_workspace_snapshot", {
            workspacePath: safeWorkspace,
            snapshotId: snapshot.snapshot_id,
          });
        }
        const responsePayload: Record<string, unknown> = {
          ok: applyResult.success,
          action_type: "apply_patch",
          auto_executed: true,
          patch_length: patch.length,
          files: applyResult.files,
          message: applyResult.message,
          ...responseMeta,
        };
        if (applyResult.success) {
          const diagnostics = await fetchPostPatchDiagnostics(
            safeWorkspace,
            applyResult.files
          );
          if (diagnostics.hasDiagnostics) {
            responsePayload.diagnostics = diagnostics.summary;
          }
        }
        return {
          content: JSON.stringify(responsePayload),
          success: applyResult.success,
          errorCategory: applyResult.success ? undefined : "validation",
          errorMessage: applyResult.success ? undefined : applyResult.message,
        };
      }

      const action: ActionProposal = {
        id: createActionId("gate-a-apply-patch"),
        toolCallId: call.id,
        toolName: call.function.name,
        type: "apply_patch",
        description: asString(
          args.description,
          `Apply structured edit for ${relativePath} (Gate A)`
        ),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          patch,
        },
      };
      action.fingerprint = actionFingerprint(action);
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "apply_patch",
          action_id: action.id,
          patch_length: patch.length,
          files: preflight.files,
          ...responseMeta,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "propose_shell") {
      const shell = asString(args.shell).trim();
      if (!shell) {
        const message = "shell 命令不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const timeout = Math.max(
        1000,
        Math.min(600000, asNumber(args.timeout_ms, 120000))
      );
      if (timeout < 1000 || timeout > 600000) {
        const message = "timeout_ms 必须在 1000-600000 之间";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (toolPermissions.propose_shell === "auto") {
        const cmdResult = await invoke<{
          success: boolean;
          command: string;
          timed_out: boolean;
          status: number;
          stdout: string;
          stderr: string;
        }>("run_shell_command", {
          workspacePath: safeWorkspace,
          shell,
          timeoutMs: timeout,
        });
        return {
          content: JSON.stringify({
            ok: cmdResult.success,
            action_type: "shell",
            auto_executed: true,
            shell,
            stdout: cmdResult.stdout,
            stderr: cmdResult.stderr,
            exit_code: cmdResult.status,
            timed_out: cmdResult.timed_out,
          }),
          success: cmdResult.success,
          errorCategory: cmdResult.success ? undefined : "validation",
          errorMessage: cmdResult.success
            ? undefined
            : `命令执行失败 (exit ${cmdResult.status})`,
        };
      }

      const action: ActionProposal = {
        id: createActionId("gate-shell"),
        toolCallId: call.id,
        toolName: call.function.name,
        type: "shell",
        description: asString(args.description, "Execute shell command (Gate)"),
        gateRequired: true,
        status: "pending",
        executed: false,
        payload: {
          shell,
          timeoutMs: timeout,
        },
      };
      action.fingerprint = actionFingerprint(action);
      return {
        content: JSON.stringify({
          ok: true,
          action_type: "shell",
          action_id: action.id,
          shell,
        }),
        success: true,
        proposedAction: action,
      };
    }

    if (call.function.name === "task") {
      const role = asString(args.role).trim();
      const description = asString(args.description).trim();
      if (!role) {
        const message = "role 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (!description) {
        const message = "description 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const validRoles: string[] = allowedSubAgents !== undefined
        ? [...allowedSubAgents]
        : DEFAULT_AGENTS.filter((agent) => agent.allowAsSubAgent).map((agent) => agent.role);
      if (!validRoles.includes(role)) {
        const message = allowedSubAgents !== undefined
          ? `当前 Agent 不允许委派给 "${role}" 角色。可用角色: ${validRoles.join(", ") || "(无)"}`
          : `无效的 Sub-Agent 角色: "${role}"。可用角色: ${validRoles.join(", ")}`;
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      if (!settings) {
        const message = "task 工具需要 settings 上下文，当前调用缺少 settings";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const subResult = await executeSubAgentTask(
        role,
        description,
        safeWorkspace,
        settings,
        toolPermissions,
        workingMemory,
      );

      // Record sub-agent execution in Working Memory
      if (workingMemory) {
        const keyFindings: string[] = [];
        if (subResult.structuredOutput?.role === "planner") {
          const plannerData = subResult.structuredOutput.data;
          if (plannerData.architectureNotes) {
            addDiscoveredFact(workingMemory, {
              category: "architecture",
              content: plannerData.architectureNotes,
              source: `planner:${description.slice(0, 100)}`,
              confidence: "high",
            });
          }
          keyFindings.push(...plannerData.tasks.map((t) => t.title));
        }
        recordSubAgentExecution(workingMemory, {
          role: role as SubAgentRole,
          taskDescription: description,
          replySummary: subResult.reply.slice(0, 500),
          proposedActionCount: subResult.proposedActions.length,
          keyFindings,
        });
      }

      const responsePayload: Record<string, unknown> = {
        ok: true,
        action_type: "sub_agent_task",
        role,
        turn_count: subResult.turnCount,
        reply: subResult.reply,
        proposed_action_count: subResult.proposedActions.length,
        tool_call_count: subResult.toolTrace.length,
        structured_output: subResult.structuredOutput?.data ?? null,
      };
      const result: ToolExecutionResult = {
        content: JSON.stringify(responsePayload),
        success: true,
      };
      if (subResult.proposedActions.length > 0) {
        result.proposedAction = subResult.proposedActions[0];
      }
      return result;
    }

    if (call.function.name === "diagnostics") {
      const changedFiles = Array.isArray(args.changed_files)
        ? (args.changed_files as string[])
            .map((f) => String(f).trim())
            .filter(Boolean)
        : undefined;
      const result = await invoke<{
        success: boolean;
        diagnostics: Array<{
          file: string;
          line: number;
          column: number;
          severity: string;
          message: string;
        }>;
        tool_used: string;
        raw_output: string;
      }>("get_workspace_diagnostics", {
        workspacePath: safeWorkspace,
        changedFiles:
          changedFiles && changedFiles.length > 0 ? changedFiles : null,
      });

      const errorCount = result.diagnostics.filter(
        (d) => d.severity === "error"
      ).length;
      const warningCount = result.diagnostics.filter(
        (d) => d.severity === "warning"
      ).length;
      const diagnosticsPreview = result.diagnostics
        .slice(0, 50)
        .map(
          (d) =>
            `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${
              d.message
            }`
        )
        .join("\n");

      return {
        content: JSON.stringify({
          ok: true,
          tool_used: result.tool_used,
          error_count: errorCount,
          warning_count: warningCount,
          total_diagnostics: result.diagnostics.length,
          diagnostics_preview: smartTruncate(
            diagnosticsPreview,
            MAX_FILE_PREVIEW_CHARS
          ),
        }),
        success: true,
      };
    }

    if (call.function.name === "fetch") {
      const url = asString(args.url).trim();
      if (!url) {
        const message = "url 不能为空";
        return {
          content: JSON.stringify({ error: message }),
          success: false,
          errorCategory: "validation",
          errorMessage: message,
        };
      }
      const maxSize = normalizeOptionalPositiveInt(args.max_size);
      const result = await invoke<{
        success: boolean;
        url: string;
        content_type: string | null;
        content: string;
        truncated: boolean;
        error: string | null;
      }>("fetch_url", {
        url,
        maxSize: maxSize || null,
        proxy: settings?.proxy ?? null,
      });

      if (!result.success) {
        const errorMsg = result.error || "请求失败";
        return {
          content: JSON.stringify({
            ok: false,
            url: result.url,
            error: errorMsg,
          }),
          success: false,
          errorCategory: "validation",
          errorMessage: errorMsg,
        };
      }

      return {
        content: JSON.stringify({
          ok: true,
          url: result.url,
          content_type: result.content_type,
          truncated: result.truncated,
          content_preview: smartTruncate(
            result.content,
            MAX_FILE_PREVIEW_CHARS
          ),
        }),
        success: true,
      };
    }

    return {
      content: JSON.stringify({
        error: `"${call.function.name}" is not a valid tool, try one of [${(enabledToolNames ?? ALL_TOOL_NAMES).join(", ")}].`,
      }),
      success: false,
      errorCategory: "tool_not_found",
      errorMessage: `未知工具: ${call.function.name}`,
    };
  } catch (error) {
    const message = String(error || "Unknown error");
    return {
      content: JSON.stringify({ error: message }),
      success: false,
      errorCategory: classifyToolError(message),
      errorMessage: message,
    };
  }
}

async function executeToolCallWithRetry(
  call: ToolCallRecord,
  workspacePath: string,
  toolPermissions: ToolPermissions = DEFAULT_TOOL_PERMISSIONS,
  settings?: AppSettings,
  projectConfig?: CofreeRcConfig,
  allowedSubAgents?: SubAgentRole[],
  enabledToolNames?: string[],
  workingMemory?: WorkingMemory,
): Promise<{
  result: ToolExecutionResult;
  trace: ToolExecutionTrace;
}> {
  const startedAt = nowIso();
  let attempts = 0;
  let lastResult: ToolExecutionResult = {
    content: JSON.stringify({ error: "工具调用未执行" }),
    success: false,
    errorCategory: "unknown",
    errorMessage: "工具调用未执行",
  };

  while (attempts < MAX_TOOL_RETRY) {
    attempts += 1;
    const current = await executeToolCall(
      call,
      workspacePath,
      toolPermissions,
      settings,
      projectConfig,
      allowedSubAgents,
      enabledToolNames,
      workingMemory,
    );
    const success = current.success !== false;
    const errorCategory =
      current.errorCategory ?? (success ? undefined : "unknown");
    const errorMessage =
      current.errorMessage ?? (success ? undefined : "工具调用失败");
    lastResult = {
      ...current,
      success,
      errorCategory,
      errorMessage,
    };

    if (success) {
      return {
        result: lastResult,
        trace: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          startedAt,
          finishedAt: nowIso(),
          attempts,
          status: "success",
          retried: attempts > 1,
          resultPreview: resultPreview(current.content),
        },
      };
    }

    if (!shouldRetryToolCall(errorCategory ?? "unknown")) {
      break;
    }
  }

  return {
    result: lastResult,
    trace: {
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      startedAt,
      finishedAt: nowIso(),
      attempts,
      status: "failed",
      retried: attempts > 1,
      errorCategory: lastResult.errorCategory,
      errorMessage: lastResult.errorMessage,
      resultPreview: resultPreview(lastResult.content),
    },
  };
}

/* requestToolCompletion: Non-streaming variant (retained for local-only fallback) */
export async function requestToolCompletion(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  droppedToolCalls: number;
  requestRecord: RequestRecord;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const body = createLiteLLMRequestBody(messages, settings, {
    stream: false,
    temperature: 0.1,
    tools: activeTools,
    toolChoice: "auto",
  });

  const t0 = performance.now();
  console.log(
    `[LLM] 发送请求 (非流式) | model=${settings.model} | messages=${messages.length} | tools=${activeTools.length}`
  );

  const response = await postLiteLLMChatCompletions(settings, body);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[LLM] 请求失败 | status=${response.status} | ${elapsed}s`);
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id
      : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const { parsed: toolCalls, droppedCount } = parseToolCalls(rawMessage.tool_calls);

  const inTok = payload.usage?.prompt_tokens;
  const outTok = payload.usage?.completion_tokens;
  console.log(
    `[LLM] 收到响应 | ${elapsed}s | toolCalls=${toolCalls.length}` +
      (droppedCount > 0 ? ` dropped=${droppedCount}` : "") +
      (inTok != null || outTok != null ? ` | in=${inTok ?? "?"} out=${outTok ?? "?"}` : "") +
      ` | id=${requestId}`
  );

  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: normalizeMessageContent(rawMessage.content),
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    assistantMessage,
    toolCalls,
    droppedToolCalls: droppedCount,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length,
      inputTokens: inTok || undefined,
      outputTokens: outTok || undefined,
    },
  };
}

async function requestToolCompletionWithStream(
  messages: LiteLLMMessage[],
  settings: AppSettings,
  activeTools: LiteLLMToolDefinition[],
  signal?: AbortSignal,
  onChunk?: (content: string) => void
): Promise<{
  assistantMessage: LiteLLMMessage;
  toolCalls: ToolCallRecord[];
  droppedToolCalls: number;
  requestRecord: RequestRecord;
}> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const body = createLiteLLMRequestBody(messages, settings, {
    stream: true,
    temperature: 0.1,
    tools: activeTools,
    toolChoice: "auto",
  });

  const t0 = performance.now();
  console.log(
    `[LLM] 发送请求 (流式) | model=${settings.model} | messages=${messages.length} | tools=${activeTools.length}`
  );

  const response = await postLiteLLMChatCompletionsStream(
    settings,
    body,
    (content) => {
      onChunk?.(content);
    }
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  if (response.status < 200 || response.status >= 300) {
    console.warn(`[LLM] 请求失败 | status=${response.status} | ${elapsed}s`);
    const detail = parseErrorMessage(response.body, response.status);
    throw new Error(`服务员响应失败: ${detail}`);
  }

  const payload = parseCompletionPayload(response.body);
  const requestId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id
      : createRequestId("chat");

  const firstChoice = payload.choices?.[0];
  const rawMessage = firstChoice?.message;
  if (!rawMessage) {
    throw new Error("模型响应缺少 message。");
  }

  const { parsed: toolCalls, droppedCount } = parseToolCalls(rawMessage.tool_calls);

  const inTok = payload.usage?.prompt_tokens;
  const outTok = payload.usage?.completion_tokens;
  console.log(
    `[LLM] 收到响应 | ${elapsed}s | toolCalls=${toolCalls.length}` +
      (droppedCount > 0 ? ` dropped=${droppedCount}` : "") +
      (inTok != null || outTok != null ? ` | in=${inTok ?? "?"} out=${outTok ?? "?"}` : "") +
      ` | id=${requestId}`
  );

  const assistantMessage: LiteLLMMessage = {
    role: "assistant",
    content: normalizeMessageContent(rawMessage.content),
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    assistantMessage,
    toolCalls,
    droppedToolCalls: droppedCount,
    requestRecord: {
      requestId,
      inputLength: inputLengthOf(messages),
      outputLength: response.body.length,
      inputTokens: inTok || undefined,
      outputTokens: outTok || undefined,
    },
  };
}

async function runNativeToolCallingLoop(
  prompt: string,
  settings: AppSettings,
  runtime: ResolvedAgentRuntime,
  phase: PlanningSessionPhase,
  conversationHistory: LiteLLMMessage[],
  internalSystemNote?: string,
  blockedActionFingerprints: string[] = [],
  signal?: AbortSignal,
  onAssistantChunk?: (chunk: string) => void,
  isContinuation?: boolean,
  projectConfig?: CofreeRcConfig,
  onToolCallEvent?: (event: ToolCallEvent) => void,
  onContextUpdate?: (estimatedTokens: number) => void
): Promise<{
  assistantReply: string;
  requestRecords: RequestRecord[];
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
}> {
  const agentToolCtx = selectAgentTools(runtime, buildAgentToolDefs(runtime));
  const activeTools = agentToolCtx.visibleToolDefs;
  const enabledToolNames = runtime.enabledTools;
  // Merge tool permissions: runtime (agent-specific) take priority, then .cofreerc overrides
  const basePermissions = runtime.toolPermissions as unknown as ToolPermissions;
  const toolPermissions: ToolPermissions = projectConfig?.toolPermissions
    ? ({
        ...basePermissions,
        ...projectConfig.toolPermissions,
      } as ToolPermissions)
    : basePermissions;
  const patchRepairInstruction =
    "请读取必要文件片段后，重新调用 propose_file_edit。";
  const createPathRepairInstruction =
    "若目标是新建文件，请调用 propose_file_edit 并设置 operation='create'；若目录不存在，可先调用 propose_shell 执行 mkdir -p <目录>。";
  const agentSystemPrompt = assembleSystemPrompt(runtime);
  const runtimeContext = assembleRuntimeContext(runtime, settings.workspacePath);
  const requestedArtifactCount =
    phase === "default" ? estimateRequestedArtifactCount(prompt) : 0;
  const blockedFingerprints = blockedActionFingerprints
    .map((value) => value.trim())
    .filter(Boolean);
  const pinnedPrefixLen = 2 + (blockedFingerprints.length > 0 ? 1 : 0);

  const messages: LiteLLMMessage[] = [
    { role: "system", content: agentSystemPrompt },
    { role: "system", content: runtimeContext },
    ...(blockedFingerprints.length > 0
      ? [
          {
            role: "system" as const,
            content: [
              "系统提示：以下动作指纹已在之前轮次执行或处理完成，禁止再次提出相同动作。",
              ...blockedFingerprints.map((fingerprint) => `- ${fingerprint}`),
              "如果没有新的必要动作，请直接给出最终总结。",
            ].join("\n"),
          },
        ]
      : []),
    ...(internalSystemNote?.trim()
      ? [{ role: "system" as const, content: internalSystemNote.trim() }]
      : []),
    ...conversationHistory,
    // Continuation must still include a real user-role message.
    // Some providers degrade tool-calling behavior or stop early when the last turn is system-only.
    ...(isContinuation
      ? [
          {
            role: "system" as const,
            content: `[任务上下文] 用户的原始请求是："${prompt}"。本轮是自动续跑（continuation），请基于已完成的工作继续完成剩余交付物。如果所有交付物均已完成，直接简短汇报。`,
          },
          { role: "user" as const, content: prompt },
        ]
      : [{ role: "user" as const, content: prompt }]),
  ];

  const requestRecords: RequestRecord[] = [];
  const proposedActions: ActionProposal[] = [];
  const toolTrace: ToolExecutionTrace[] = [];
  let patchRepairRounds = 0;
  let createHintRepairRounds = 0;
  let multiArtifactReminderRounds = 0;
  let toolNotFoundStrikes = 0;
  let consecutiveFailureTurns = 0;

  // --- Context window management ---
  const limitTokens = settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000;

  // --- Shared Working Memory for multi-agent collaboration ---
  const workingMemory = createWorkingMemory({
    maxTokenBudget: Math.floor(
      Math.max(0, limitTokens - Math.min(8000, Math.max(512, Math.floor(limitTokens * 0.15)))) * 0.9 * 0.2
    ),
    projectContext: internalSystemNote?.slice(0, 500) ?? "",
  });
  const outputBufferTokens = Math.min(
    8000,
    Math.max(512, Math.floor(limitTokens * 0.15))
  );
  const hardPromptBudget = Math.max(0, limitTokens - outputBufferTokens);
  const softPromptBudget = Math.floor(hardPromptBudget * 0.9);
  const promptBudgetTarget = softPromptBudget > 0 ? softPromptBudget : hardPromptBudget;

  // P0-2: Pre-compute tool definition overhead and pass to compression policy.
  const toolDefTokens = estimateTokensForToolDefinitions(activeTools);
  console.log(`[Loop] 工具定义 token 开销: ~${toolDefTokens} tokens (${activeTools.length} tools)`);

  const compressionPolicy = {
    maxPromptTokens: promptBudgetTarget,
    minMessagesToSummarize: MIN_MESSAGES_TO_SUMMARIZE,
    minRecentMessagesToKeep: MIN_RECENT_MESSAGES_TO_KEEP,
    recentTokensMinRatio: RECENT_TOKENS_MIN_RATIO,
    toolMessageMaxChars: TOOL_MESSAGE_MAX_CHARS,
    mergeToolMessages: true,
    toolDefinitionTokens: toolDefTokens,
  };

  const summarizer = {
    canSummarize: () => {
      const estTokens = estimateTokensForMessages(messages);
      return canSummarizeNow(settings.workspacePath, estTokens);
    },
    summarize: (messagesToSummarize: LiteLLMMessage[]) =>
      requestSummary(messagesToSummarize, settings, {
        workspacePath: settings.workspacePath,
      }),
    markSummarized: () => markSummarizedNow(settings.workspacePath),
  };

  for (let turn = 0; ; turn += 1) {
    if (turn > 0 && turn % TOOL_LOOP_CHECKPOINT_TURNS === 0) {
      console.log(`[Loop] 已运行 ${turn} 轮，到达检查点，暂停等待用户确认`);
      return {
        assistantReply: `已经持续调用了 ${turn} 轮工具，任务仍在进行中。如果需要继续，请回复「继续」。`,
        requestRecords,
        proposedActions,
        toolTrace,
      };
    }

    const estTokens = estimateTokensForMessages(messages);
    console.log(
      `[Loop] ── Turn ${turn + 1} ── messages=${messages.length} | ~${estTokens} tokens`
    );

    if (turn === TOOL_LOOP_EFFICIENCY_WARNING_THRESHOLD) {
      messages.push({
        role: "system",
        content: [
          `系统提示：你已经使用了 ${turn} 轮工具调用。`,
          "请注意效率，优先使用 grep/glob 批量搜索而非逐个文件阅读。",
          "如果任务已基本完成，请尽快给出最终总结；如果确实需要继续，请集中处理剩余关键步骤。",
        ].join("\n"),
      });
    }

    const compression = await compressMessagesToFitBudget({
      messages,
      policy: compressionPolicy,
      summarizer,
      pinnedPrefixLen,
    });
    if (compression.compressed && compression.messages !== messages) {
      const beforeLen = messages.length;
      messages.splice(0, messages.length, ...compression.messages);
      console.log(
        `[Loop] 上下文压缩: ${beforeLen} → ${messages.length} messages | ~${estimateTokensForMessages(messages)} tokens`
      );
    }
    onContextUpdate?.(estimateTokensForMessages(messages));


    const completion = await requestToolCompletionWithStream(
      messages,
      settings,
      activeTools,
      signal,
      onAssistantChunk
    );
    requestRecords.push(completion.requestRecord);
    messages.push(completion.assistantMessage);

    // P1-3: Update token calibration with actual API-reported values (per-model).
    if (completion.requestRecord.inputTokens) {
      const estBeforeCall = estimateTokensForMessages(messages) + toolDefTokens;
      updateTokenCalibration(estBeforeCall, completion.requestRecord.inputTokens, settings.model);
    }

    if (!completion.toolCalls.length) {
      if (completion.droppedToolCalls > 0) {
        console.warn(`[Loop] Turn ${turn + 1}: ${completion.droppedToolCalls} 个工具调用因格式畸形被丢弃，要求模型重试`);
        messages.push({
          role: "system",
          content: [
            `系统提示：模型尝试了 ${completion.droppedToolCalls} 个工具调用，但全部因格式畸形被丢弃（缺少 function.name 或 arguments 不是字符串）。`,
            `可用工具: [${enabledToolNames.join(", ")}]`,
            "请使用正确的工具调用格式重试。",
          ].join("\n"),
        });
        continue;
      }
      console.log(`[Loop] Turn ${turn + 1} 结束: 模型返回文本回复 (无工具调用)`);
      const finalText = completion.assistantMessage.content.trim();
      return {
        assistantReply: finalText,
        requestRecords,
        proposedActions,
        toolTrace,
      };
    }

    const toolNames = completion.toolCalls.map((tc) => tc.function.name);
    console.log(
      `[Loop] Turn ${turn + 1} 收到 ${completion.toolCalls.length} 个工具调用: [${toolNames.join(", ")}]`
    );

    let patchPreflightFailure: string | null = null;
    let createPathUsageFailure: string | null = null;
    let turnHasToolNotFound = false;
    let turnSuccessCount = 0;
    let turnFailureCount = 0;
    for (const toolCall of completion.toolCalls) {
      onToolCallEvent?.({
        type: "start",
        callId: toolCall.id,
        toolName: toolCall.function.name,
        argsPreview: summarizeToolArgs(toolCall.function.name, toolCall.function.arguments),
      });

      const toolT0 = performance.now();
      const { result: toolResult, trace } = await executeToolCallWithRetry(
        toolCall,
        settings.workspacePath,
        toolPermissions,
        settings,
        projectConfig,
        runtime.allowedSubAgents,
        enabledToolNames,
        workingMemory,
      );
      const toolMs = (performance.now() - toolT0).toFixed(0);

      onToolCallEvent?.({
        type: "end",
        callId: toolCall.id,
        toolName: toolCall.function.name,
        result: trace.status,
        resultPreview: trace.resultPreview,
      });

      console.log(
        `[Tool] ${toolCall.function.name} → ${trace.status} | ${toolMs}ms` +
          (trace.retried ? ` (retried ×${trace.attempts})` : "") +
          (trace.status === "failed" ? ` | ${trace.errorCategory}: ${trace.errorMessage}` : "")
      );

      toolTrace.push(trace);

      if (toolResult.success === false) {
        turnFailureCount += 1;
        if (toolResult.errorCategory === "tool_not_found") {
          turnHasToolNotFound = true;
        }
      } else {
        turnSuccessCount += 1;
        // Extract file knowledge from successful tool results into Working Memory
        try {
          const parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
          const knowledge = extractFileKnowledge(
            toolCall.function.name,
            parsedArgs,
            toolResult.content,
            "main",
          );
          if (knowledge) {
            workingMemory.fileKnowledge.set(knowledge.relativePath, knowledge);
          }
        } catch {
          // Ignore parse errors for working memory extraction
        }
      }

      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        (toolCall.function.name === "propose_apply_patch" ||
          toolCall.function.name === "propose_file_edit") &&
        (toolResult.errorMessage ?? "").includes("Patch 预检失败")
      ) {
        patchPreflightFailure = toolResult.errorMessage ?? "Patch 预检失败";
      }
      if (
        toolResult.success === false &&
        toolResult.errorCategory === "validation" &&
        toolCall.function.name === "propose_file_edit" &&
        ((toolResult.errorMessage ?? "")
          .toLowerCase()
          .includes("invalid target path") ||
          (toolResult.errorMessage ?? "")
            .toLowerCase()
            .includes("no such file or directory"))
      ) {
        createPathUsageFailure = toolResult.errorMessage ?? "目标路径不存在";
      }
      if (toolResult.proposedAction) {
        proposedActions.push(toolResult.proposedAction);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: trimToolContentForContext(
          toolCall.function.name,
          toolResult.content
        ),
      });
    }

    // Notify caller of updated context size after all tool results are added
    onContextUpdate?.(estimateTokensForMessages(messages));

    // --- Circuit breaker: tool_not_found ---
    if (turnHasToolNotFound) {
      toolNotFoundStrikes += 1;
    } else {
      toolNotFoundStrikes = 0;
    }
    if (toolNotFoundStrikes >= MAX_TOOL_NOT_FOUND_STRIKES) {
      console.warn(`[Loop] 熔断: tool_not_found 连续 ${toolNotFoundStrikes} 轮，终止循环`);
      return {
        assistantReply:
          "模型多次调用不存在的工具，已自动终止。请检查模型能力或切换至更强的模型。",
        requestRecords,
        proposedActions,
        toolTrace,
      };
    }
    if (toolNotFoundStrikes > 0 && toolNotFoundStrikes < MAX_TOOL_NOT_FOUND_STRIKES) {
      messages.push({
        role: "system",
        content: [
          `系统提示：你调用了不存在的工具（连续 ${toolNotFoundStrikes} 轮）。`,
          `你只能使用以下工具: [${enabledToolNames.join(", ")}]`,
          "请严格从上述列表中选择工具，不要臆造工具名称。",
        ].join("\n"),
      });
    }

    // --- Circuit breaker: consecutive all-failure turns ---
    if (turnSuccessCount === 0 && turnFailureCount > 0) {
      consecutiveFailureTurns += 1;
    } else {
      consecutiveFailureTurns = 0;
    }
    if (consecutiveFailureTurns >= MAX_CONSECUTIVE_FAILURE_TURNS) {
      console.warn(`[Loop] 熔断: 连续 ${consecutiveFailureTurns} 轮全部失败，终止循环`);
      return {
        assistantReply:
          "连续多轮工具调用全部失败，已自动终止。请检查工具参数或任务描述后重试。",
        requestRecords,
        proposedActions,
        toolTrace,
      };
    }

    if (
      !proposedActions.length &&
      patchPreflightFailure &&
      patchRepairRounds < MAX_PATCH_REPAIR_ROUNDS
    ) {
      patchRepairRounds += 1;
      messages.push({
        role: "system",
        content: [
          "系统提示：上一轮 patch 预检失败。",
          `错误信息：${patchPreflightFailure}`,
          patchRepairInstruction,
          "仅允许一次自动修复重试，并保持最小改动。",
        ].join("\n"),
      });
      continue;
    }

    if (
      !proposedActions.length &&
      createPathUsageFailure &&
      createHintRepairRounds < MAX_CREATE_HINT_REPAIR_ROUNDS
    ) {
      createHintRepairRounds += 1;
      messages.push({
        role: "system",
        content: [
          "系统提示：检测到文件创建路径问题。",
          `错误信息：${createPathUsageFailure}`,
          createPathRepairInstruction,
        ].join("\n"),
      });
      continue;
    }

    const plannedArtifacts = countPlannedArtifacts(proposedActions);

    if (requestedArtifactCount > 1) {
      if (
        plannedArtifacts > 0 &&
        plannedArtifacts < requestedArtifactCount &&
        multiArtifactReminderRounds < MAX_MULTI_ARTIFACT_REMINDER_ROUNDS &&
        proposedActions.length < MAX_PROPOSED_ACTIONS_PER_BATCH
      ) {
        multiArtifactReminderRounds += 1;
        messages.push({
          role: "system",
          content: [
            "系统提示：用户请求包含多个交付物。",
            `当前已提出 ${plannedArtifacts} 个交付物相关动作，目标至少 ${requestedArtifactCount} 个。`,
            "请继续提出剩余缺失交付物的审批动作；不要重复已有动作。",
            "仅在所有请求交付物都已覆盖，或确实无法继续时，才停止工具调用。",
          ].join("\n"),
        });
        continue;
      }
    }

    if (proposedActions.length > 0) {
      const reachedBatchLimit =
        proposedActions.length >= MAX_PROPOSED_ACTIONS_PER_BATCH;
      const coverageSatisfied =
        requestedArtifactCount <= 1 ||
        plannedArtifacts === 0 ||
        plannedArtifacts >= requestedArtifactCount;
      const shouldReturnNow =
        reachedBatchLimit ||
        coverageSatisfied ||
        multiArtifactReminderRounds >= MAX_MULTI_ARTIFACT_REMINDER_ROUNDS;

      if (!shouldReturnNow) {
        messages.push({
          role: "system",
          content:
            "系统提示：你已经提出了部分待审批动作。请继续补齐剩余缺失交付物，直到达到交付覆盖目标或达到单批动作上限。",
        });
        continue;
      }

      return {
        assistantReply: completion.assistantMessage.content.trim(),
        requestRecords,
        proposedActions,
        toolTrace,
      };
    }
  }

  console.warn(`[Loop] 主循环意外退出`);
  return {
    assistantReply: "工具调用循环已结束。如果任务尚未完成，请回复「继续」。",
    requestRecords,
    proposedActions,
    toolTrace,
  };
}

function sanitizeStepsFromPrompt(prompt: string): PlanStep[] {
  const normalized = prompt.trim() || "实现用户提出的功能";
  return [
    {
      id: "step-plan",
      owner: "planner",
      summary: `分析需求并拆解执行步骤: ${normalized}`,
    },
    {
      id: "step-implement",
      owner: "coder",
      summary: "基于任务生成实现或回答",
    },
    {
      id: "step-verify",
      owner: "tester",
      summary: "补充验证建议并总结风险",
    },
  ];
}

function buildProposedActions(
  fromTools: ActionProposal[],
  blockedFingerprints: Iterable<string> = []
): ActionProposal[] {
  const uniqueActions: ActionProposal[] = [];
  const seen = new Set<string>();
  const blocked = new Set(
    Array.from(blockedFingerprints, (value) => value.trim()).filter(Boolean)
  );

  for (const action of fromTools) {
    const validationError = validateProposedAction(action);
    if (validationError) {
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (blocked.has(fingerprint)) {
      continue;
    }
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    uniqueActions.push(action);
  }

  // --- Phase 5: Action Group semantics for multi-patch batches ---
  // Only when the same round produces 2+ patch actions, we assign a shared groupId.
  const patchActions = uniqueActions.filter(
    (a): a is import("./types").ApplyPatchActionProposal =>
      a.type === "apply_patch"
  );
  if (patchActions.length > 1) {
    const groupId = createActionId("action-group");
    const createdAt = nowIso();
    const files = Array.from(
      new Set(patchActions.flatMap((a) => collectPatchedFiles(a.payload.patch)))
    );
    const title =
      files.length > 0
        ? `批量补丁（${files.length} 个文件）`
        : `批量补丁（${patchActions.length} 个 patch）`;

    for (const action of patchActions) {
      action.group = {
        groupId,
        title,
        atomicIntent: true,
        createdAt,
      };
    }
  }

  return uniqueActions;
}

function initializePlan(
  prompt: string,
  settings: AppSettings,
  proposedActions: ActionProposal[]
): OrchestrationPlan {
  const steps = sanitizeStepsFromPrompt(prompt);
  return {
    state: proposedActions.length ? "human_review" : "done",
    prompt: prompt.trim() || "实现用户提出的功能",
    steps,
    proposedActions,
    workspacePath: settings.workspacePath.trim(),
  };
}

export function actionFingerprint(action: ActionProposal): string {
  if (action.type === "apply_patch") {
    const normalizedPatch = normalizeWhitespace(action.payload.patch);
    const patchHash = hashText(normalizedPatch);
    const files = collectPatchedFiles(action.payload.patch)
      .map((file) => file.trim())
      .filter(Boolean)
      .sort();
    const operationKinds = detectPatchOperationKinds(action.payload.patch);

    // Fingerprint must be stable enough to block exact duplicates,
    // but not so coarse that any follow-up edit to the same file becomes impossible.
    const context =
      files.length > 0
        ? `${operationKinds.join(",")}:${files.join("|")}`
        : "raw";
    return `${action.type}:${context}:${patchHash}`;
  }
  // action.type === "shell"
  const normalizedShell = normalizeWhitespace(action.payload.shell);
  return `${action.type}:${normalizedShell}:${action.payload.timeoutMs}`;
}

function validateProposedAction(action: ActionProposal): string | null {
  if (action.type === "apply_patch") {
    if (!action.payload.patch.trim()) {
      return "patch 不能为空";
    }
    return null;
  }

  if (action.type === "shell") {
    if (!action.payload.shell.trim()) {
      return "shell 命令不能为空";
    }
    if (action.payload.timeoutMs < 1000 || action.payload.timeoutMs > 600000) {
      return "timeout 超出范围";
    }
    return null;
  }

  return null;
}


function containsCapabilityDenial(text: string): boolean {
  const corpus = text.toLowerCase();
  const hints = [
    "只读",
    "read-only",
    "无法执行文件创建",
    "当前工具路由模式为只读",
    "仅支持 [list_files, read_file, git_status, git_diff]",
  ];
  return hints.some((hint) => corpus.includes(hint.toLowerCase()));
}

const APPROVAL_CARD_CLAIM_HINTS = [
  "审批卡片",
  "待审批动作",
  "查看下方",
  "查看审批",
  "审批面板",
];

function containsApprovalCardClaim(text: string): boolean {
  const corpus = text.toLowerCase();
  return APPROVAL_CARD_CLAIM_HINTS.some((hint) => corpus.includes(hint));
}

function stripApprovalCardClaims(text: string): string {
  const sentences = text.split(/(?<=[。！？\n])/);
  const kept = sentences.filter(
    (s) => !APPROVAL_CARD_CLAIM_HINTS.some((h) => s.includes(h))
  );
  return kept.join("").trim();
}

function reconcileAssistantReply(params: {
  assistantReply: string;
  proposedActions: ActionProposal[];
  toolTrace: ToolExecutionTrace[];
}): string {
  const { assistantReply, proposedActions, toolTrace } = params;
  const normalized = assistantReply.trim();

  if (!normalized) {
    if (proposedActions.length > 0) {
      return "已生成待审批动作，请查看下方审批卡片。";
    }
    // 兜底：有工具调用但LLM未返回文本（弱模型常见）
    if (toolTrace.length > 0) {
      const hasSuccess = toolTrace.some((t) => t.status === "success");
      if (hasSuccess) {
        return "已完成工具调用。";
      }
      return "工具调用已结束。";
    }
    // 最终兜底：确保不返回空字符串
    return "处理完成。";
  }

  // 反向修正：LLM 文本声称生成了审批卡片，但实际 proposedActions 为空
  if (proposedActions.length === 0 && containsApprovalCardClaim(normalized)) {
    const cleaned = stripApprovalCardClaims(normalized);
    if (cleaned) {
      return cleaned;
    }
    if (toolTrace.length > 0) {
      const hasSuccess = toolTrace.some((t) => t.status === "success");
      return hasSuccess
        ? "已完成工具调用，但未能生成有效的审批动作。请检查任务描述后重试。"
        : "工具调用未能成功生成审批动作，请检查任务描述后重试。";
    }
    return "处理完成。";
  }

  if (!containsCapabilityDenial(normalized)) {
    return normalized;
  }

  const hasSuccessfulToolCall = toolTrace.some(
    (trace) => trace.status === "success"
  );
  if (!hasSuccessfulToolCall) {
    return normalized;
  }

  if (proposedActions.length > 0) {
    return "已生成待审批动作，请查看下方审批卡片。";
  }

  return normalized;
}

function assertLocalOnlyPolicy(settings: AppSettings): void {
  if (settings.allowCloudModels) {
    return;
  }

  if (isActiveModelLocal(settings)) {
    return;
  }

  throw new LocalOnlyPolicyError(
    "Local-only 已开启，请切换到本地 Provider（如 Ollama）后再发起请求。"
  );
}

export async function runPlanningSession(
  input: RunPlanningSessionInput
): Promise<PlanningSessionResult> {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("请输入任务描述后再发送。");
  }

  assertLocalOnlyPolicy(input.settings);
  const phase = input.phase ?? "default";
  const historyMessages = normalizeConversationHistory(input.conversationHistory);
  const runtime = resolveAgentRuntime(input.agentId ?? null, input.settings);

  const sessionT0 = performance.now();
  console.log(
    `[Planning] ═══ 会话开始 ═══ | agent=${runtime.agentId} | model=${input.settings.model} | phase=${phase} | history=${historyMessages.length} | continuation=${!!input.isContinuation}`
  );
  console.log(`[Planning] prompt: "${normalizedPrompt.slice(0, 120)}${normalizedPrompt.length > 120 ? "…" : ""}"`
  );

  let initialInternalNote = input.internalSystemNote;
  let projectConfig: CofreeRcConfig = {};

  if (
    historyMessages.length === 0 &&
    !input.isContinuation &&
    input.settings.workspacePath
  ) {
    // Load project-level .cofreerc config
    try {
      projectConfig = await loadCofreeRc(input.settings.workspacePath);
    } catch (e) {
      console.warn("Failed to load .cofreerc", e);
    }

    // Inject workspace overview
    try {
      const overviewBudget: WorkspaceOverviewBudget | undefined =
        projectConfig.overviewBudget;

      const overview = await summarizeWorkspaceFiles(
        input.settings.workspacePath,
        projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
          ? projectConfig.ignorePatterns
          : null,
        overviewBudget
      );
      const overviewPrompt = `项目概览：\n${overview}`;
      if (initialInternalNote) {
        initialInternalNote = `${initialInternalNote}\n\n${overviewPrompt}`;
      } else {
        initialInternalNote = overviewPrompt;
      }
    } catch (e) {
      console.warn("Failed to generate workspace overview", e);
    }

    // Inject .cofreerc prompt fragment
    const rcFragment = buildCofreeRcPromptFragment(projectConfig);
    if (rcFragment) {
      if (initialInternalNote) {
        initialInternalNote = `${initialInternalNote}\n\n${rcFragment}`;
      } else {
        initialInternalNote = rcFragment;
      }
    }

    // Load contextFiles specified in .cofreerc
    if (
      projectConfig.contextFiles &&
      projectConfig.contextFiles.length > 0 &&
      input.settings.workspacePath
    ) {
      const contextSnippets: string[] = [];
      const ignorePatterns =
        projectConfig.ignorePatterns && projectConfig.ignorePatterns.length > 0
          ? projectConfig.ignorePatterns
          : null;

      for (const relPath of projectConfig.contextFiles) {
        try {
          const result = await invoke<{
            content: string;
            total_lines: number;
            start_line: number;
            end_line: number;
          }>("read_workspace_file", {
            workspacePath: input.settings.workspacePath,
            relativePath: relPath,
            startLine: null,
            endLine: null,
            ignorePatterns,
          });
          if (result.content && result.content.trim()) {
            const truncated =
              result.content.length > 2000
                ? result.content.slice(0, 2000) + "\n... (truncated)"
                : result.content;
            contextSnippets.push(`--- ${relPath} ---\n${truncated}`);
          }
        } catch {
          // File not found / ignored / can't be read — skip silently
        }
      }
      if (contextSnippets.length > 0) {
        const contextBlock = `[项目关键文件]\n${contextSnippets.join("\n\n")}`;
        initialInternalNote = initialInternalNote
          ? `${initialInternalNote}\n\n${contextBlock}`
          : contextBlock;
      }
    }
  }

  try {
    const loopResult = await runNativeToolCallingLoop(
      normalizedPrompt,
      input.settings,
      runtime,
      phase,
      historyMessages,
      initialInternalNote,
      input.blockedActionFingerprints,
      input.signal,
      input.onAssistantChunk,
      input.isContinuation,
      projectConfig,
      input.onToolCallEvent,
      input.onContextUpdate
    );
    for (const record of loopResult.requestRecords) {
      recordLLMAudit({
        requestId: record.requestId,
        provider: input.settings.provider ?? input.settings.liteLLMBaseUrl,
        model: input.settings.model,
        timestamp: new Date().toISOString(),
        inputLength: record.inputLength,
        outputLength: record.outputLength,
      });
    }

    // Compute total token usage across all turns.
    // Prefer actual API-reported values; fall back to estimates (1 token ≈ 2.5 chars).
    // For input tokens, use the last turn's prompt_tokens (it represents the full context size).
    // For output tokens, sum all turns' completion_tokens.
    const lastRecord = loopResult.requestRecords[loopResult.requestRecords.length - 1];
    const totalInputTokens = lastRecord
      ? (lastRecord.inputTokens ?? Math.ceil(lastRecord.inputLength / 2.5))
      : 0;
    const totalOutputTokens = loopResult.requestRecords.reduce((sum, r) => {
      return sum + (r.outputTokens ?? Math.ceil(r.outputLength / 2.5));
    }, 0);

    const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
    console.log(
      `[Planning] ═══ 会话完成 ═══ | ${sessionElapsed}s` +
        ` | turns=${loopResult.requestRecords.length}` +
        ` | tools=${loopResult.toolTrace.length}` +
        ` | actions=${loopResult.proposedActions.length}` +
        ` | in≈${totalInputTokens} out≈${totalOutputTokens}`
    );

    const proposedActions = buildProposedActions(
      loopResult.proposedActions,
      input.blockedActionFingerprints
    );
    const plan = initializePlan(
      normalizedPrompt,
      input.settings,
      proposedActions
    );
    const assistantReply = reconcileAssistantReply({
      assistantReply: loopResult.assistantReply,
      proposedActions,
      toolTrace: loopResult.toolTrace,
    });

    return {
      assistantReply,
      plan,
      toolTrace: loopResult.toolTrace,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
      console.log(`[Planning] 会话被用户中止 | ${sessionElapsed}s`);
      throw error;
    }
    const sessionElapsed = ((performance.now() - sessionT0) / 1000).toFixed(2);
    console.error(`[Planning] ═══ 会话失败 ═══ | ${sessionElapsed}s |`, error);
    const errorMessage = String(error || "Unknown error");
    const fallbackPlan = initializePlan(normalizedPrompt, input.settings, []);
    return {
      assistantReply: `服务员暂时无法完成本轮工具调用，请稍后重试。\n\n**错误详情**：\n\`\`\`\n${errorMessage}\n\`\`\``,
      plan: fallbackPlan,
      toolTrace: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
