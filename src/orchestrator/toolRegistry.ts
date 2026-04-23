import type { LiteLLMToolDefinition } from "../lib/piAiBridge";
import type { ResolvedAgentRuntime } from "../agents/types";

export const INTERNAL_TOOL_NAMES = [] as const;

const TOOL_DEFINITIONS: LiteLLMToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories under a workspace-relative path. Returns name, type, size, modification time. Up to 120 entries.",
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
        "Read a text file. Returns content with line number prefixes ('行号│内容'), total_lines, showing_lines. " +
        "Line number prefixes are display-only — do NOT include them in propose_file_edit search/anchor. " +
        "Large files (400+ lines): use start_line/end_line to read in ~300-line segments.",
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
            description: "1-based start line for partial read.",
          },
          end_line: {
            type: "number",
            minimum: 1,
            description: "1-based end line (inclusive) for partial read.",
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
        "Get git status: modified, staged, untracked, deleted files. Returns empty for non-git directories.",
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
        "Get unified diff of uncommitted changes. Optionally filter to a single file. Returns empty for non-git directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Optional file path to filter diff.",
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
        "Search file contents using regex. Returns matching lines with file paths and line numbers. " +
        "Use BEFORE read_file to locate code. Auto-excludes .git, node_modules, target, dist, build.",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description: "Regex pattern to search for.",
          },
          include_glob: {
            type: "string",
            description: "Optional glob to restrict search (e.g. '*.ts').",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 200,
            description: "Max matching lines. Defaults to 50.",
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
        "Find files by glob pattern. Returns paths sorted by modification time. Auto-excludes .git, node_modules, etc.",
      parameters: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            minLength: 1,
            description: "Glob pattern (e.g. '**/*.tsx', 'src/**/*.test.ts').",
          },
          max_results: {
            type: "number",
            minimum: 1,
            maximum: 500,
            description: "Max files to return. Defaults to 100.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_file_edit",
      description: [
        "Propose a single-file text edit for HITL approval. Operations:",
        "- REPLACE (default): relative_path + (search OR start_line/end_line) + replace/content",
        "- INSERT: operation='insert', content + (anchor OR line), position='before'|'after'",
        "- DELETE: operation='delete' + (search OR start_line/end_line)",
        "- CREATE: operation='create', content (+ overwrite=true to overwrite existing)",
        "- PATCH: operation='patch', patch (raw single-file unified diff)",
        "",
        "Rules: search/anchor must exactly match file content (no line number prefixes '行号│'). relative_path is REQUIRED for every operation EXCEPT 'patch' (path is parsed from the diff header).",
      ].join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          relative_path: {
            type: "string",
            minLength: 1,
            description:
              "Workspace-relative file path. Required for all operations except 'patch'.",
          },
          operation: {
            type: "string",
            enum: ["replace", "insert", "delete", "create", "patch"],
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
          patch: {
            type: "string",
            description:
              "For operation='patch': unified diff for ONE file. Must include 'diff --git' header. New files: '--- /dev/null'. Deletes: '+++ /dev/null'. Multi-file patches rejected.",
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
        "Propose a shell command for HITL approval. Windows: PowerShell; Unix: sh. " +
        "Non-interactive (stdin=/dev/null, CI=true) — use --yes/-y for prompts. " +
        "Long-running commands auto-move to background after block_until_ms deadline.",
      parameters: {
        type: "object",
        required: ["shell"],
        additionalProperties: false,
        properties: {
          shell: {
            type: "string",
            minLength: 1,
            description: "Shell command. Windows: PowerShell syntax; Unix: POSIX shell.",
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description: "Hard timeout in ms. Defaults to 120000.",
          },
          block_until_ms: {
            type: "number",
            minimum: 1000,
            maximum: 600000,
            description: "Max wait before moving to background. Auto-inferred by command type.",
          },
          execution_mode: {
            type: "string",
            enum: ["foreground", "background"],
            description: "'background' for dev servers/watchers. Usually auto-detected.",
          },
          ready_url: {
            type: "string",
            description: "URL to probe for background command readiness.",
          },
          ready_timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 120000,
            description: "Readiness timeout for background commands. Defaults to 20000.",
          },
          description: {
            type: "string",
            description: "Optional description.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_shell_job",
      description:
        "Check if a background shell job is still running. Returns status, exit_code, stdout, stderr when completed.",
      parameters: {
        type: "object",
        required: ["job_id"],
        additionalProperties: false,
        properties: {
          job_id: {
            type: "string",
            description: "The job_id from propose_shell background result.",
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
        "Get compilation errors/warnings. Auto-detects project type (TypeScript, Rust, Python, Go).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          changed_files: {
            type: "array",
            items: { type: "string" },
            description: "Optional file paths to filter diagnostics.",
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
        "Fetch content from a URL. Max 512KB, truncated if larger.",
      parameters: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            minLength: 1,
            description: "URL to fetch.",
          },
          max_size: {
            type: "number",
            minimum: 1024,
            maximum: 524288,
            description: "Max content size in bytes. Defaults to 512KB.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question and wait for response. Pauses execution until answered. " +
        "Provide options for multiple-choice. '其他' option auto-appended when options given.",
      parameters: {
        type: "object",
        required: ["question"],
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            minLength: 1,
            description: "Question to ask.",
          },
          context: {
            type: "string",
            description: "Optional context.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional predefined choices.",
          },
          allow_multiple: {
            type: "boolean",
            description: "Allow multiple selections. Defaults to false.",
          },
          required: {
            type: "boolean",
            description: "Whether answer is required. Defaults to true.",
          },
        },
      },
    },
  },
];

export function buildAgentToolDefs(runtime: ResolvedAgentRuntime): LiteLLMToolDefinition[] {
  const enabled = new Set<string>([...runtime.enabledTools, ...INTERNAL_TOOL_NAMES]);
  return TOOL_DEFINITIONS.filter((toolDef) => enabled.has(toolDef.function.name));
}
