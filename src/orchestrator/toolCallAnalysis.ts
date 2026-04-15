export interface ToolContentTrimDeps {
  smartTruncate: (content: string, maxLength: number, headRatio?: number) => string;
}

const MAX_TOOL_OUTPUT_CHARS = 15000; // hard cap for tool content injected into LLM context
const MAX_GREP_PREVIEW_MATCHES = 30;
const MAX_GREP_PREVIEW_CHARS = 8000;
const MAX_GLOB_PREVIEW_FILES = 60;
const MAX_GLOB_PREVIEW_CHARS = 6000;
const MAX_SHELL_TOOL_PREVIEW_CHARS = 6000;
const MAX_FETCH_PREVIEW_CHARS = 10000;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectPseudoToolCallNarration(
  content: string,
  availableToolNames: string[],
): string | null {
  const normalized = content.trim();
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const mentionedTool = availableToolNames.find((toolName) =>
    new RegExp(`\\b${escapeRegex(toolName.toLowerCase())}\\b`, "i").test(lower),
  );
  if (!mentionedTool) {
    return null;
  }

  const pseudoPatterns: Array<{ pattern: RegExp; reason: string }> = [
    {
      pattern: /\b(?:let'?s|i(?:'|’)ll|i will|need to|must|should|going to)\s+(?:call|use|invoke|run|execute)\b/i,
      reason: "narrated_tool_intent",
    },
    {
      pattern: /\btool\s*call\b/i,
      reason: "mentions_tool_call_literal",
    },
    {
      pattern: /\b(?:call|use|invoke)\s+(?:the\s+)?[a-z_][a-z0-9_]*\b/i,
      reason: "direct_call_phrase",
    },
    {
      pattern: /\b(?:functions?\.|to=functions\.)[a-z_][a-z0-9_]*\b/i,
      reason: "sdk_style_tool_reference",
    },
    {
      pattern: /\bcalling\s+(?:the\s+)?(?:tool|function)\b/i,
      reason: "calling_tool_phrase",
    },
    {
      pattern: /```(?:json|tool_call|function_call)?\s*\n?\s*\{\s*"(?:name|function|tool)"/i,
      reason: "code_block_tool_call",
    },
    {
      pattern: /\bI(?:'m| am)\s+(?:now\s+)?(?:going to|about to)\s+(?:call|use|invoke|run)\b/i,
      reason: "self_narration_intent",
    },
  ];

  const matched = pseudoPatterns.find(({ pattern }) => pattern.test(normalized));
  return matched ? `${matched.reason}:${mentionedTool}` : null;
}

export function detectPseudoToolJsonTranscript(content: string): string | null {
  const normalized = content.trim();
  if (!normalized) {
    return null;
  }

  const looksJsonish =
    normalized.startsWith("{") ||
    normalized.startsWith("[") ||
    /}\s*,?\s*\{/.test(normalized);

  const toolArgumentPatterns = [
    /"relative_path"\s*:/i,
    /"start_line"\s*:/i,
    /"end_line"\s*:/i,
    /"include_glob"\s*:/i,
    /"pattern"\s*:/i,
    /"shell"\s*:/i,
    /"patch"\s*:/i,
    /"url"\s*:/i,
    /"question"\s*:/i,
    /"step_id"\s*:/i,
    /"operation"\s*:/i,
  ];
  const toolResultPatterns = [
    /"ok"\s*:\s*(?:true|false)/i,
    /"error"\s*:/i,
    /"content_preview"\s*:/i,
    /"showing_lines"\s*:/i,
    /"approval_required"\s*:/i,
    /\b(?:read_file|list_files|grep|glob|git_status|git_diff|propose_file_edit|propose_apply_patch|propose_shell|fetch|ask_user)\s+failed\b/i,
  ];

  const hasToolArguments = toolArgumentPatterns.some((pattern) => pattern.test(normalized));
  const hasToolResults = toolResultPatterns.some((pattern) => pattern.test(normalized));

  if (looksJsonish && hasToolArguments && hasToolResults) {
    return "json_tool_io_transcript";
  }
  if (looksJsonish && hasToolArguments) {
    return "json_tool_arguments";
  }
  if (looksJsonish && hasToolResults) {
    return "json_tool_results";
  }
  if (hasToolArguments && hasToolResults) {
    return "tool_io_transcript";
  }
  return null;
}

function extractStringArg(
  argsJson: string,
  keys: string[],
): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    // Fall through to partial-JSON extraction below.
  }

  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = argsJson.match(
      new RegExp(`"${escapedKey}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`)
    );
    if (match?.[1]) {
      return match[1].replace(/\\"/g, '"').trim();
    }
  }

  return "";
}

export function summarizeToolArgs(toolName: string, argsJson: string): string {
  const pathPreview = extractStringArg(argsJson, [
    "relative_path",
    "file_path",
    "path",
  ]);

  switch (toolName) {
    case "read_file":
      return pathPreview;
    case "list_files":
      return pathPreview || "/";
    case "grep": {
      const pattern = extractStringArg(argsJson, ["pattern"]);
      const includeGlob = extractStringArg(argsJson, ["include_glob"]);
      return pattern
        ? `"${pattern.slice(0, 30)}"${includeGlob ? ` in ${includeGlob}` : ""}`
        : "";
    }
    case "glob":
      return extractStringArg(argsJson, ["pattern"]).slice(0, 40);
    case "git_status":
      return "";
    case "git_diff":
      return pathPreview || "(all)";
    case "propose_file_edit":
      return pathPreview;
    case "propose_apply_patch": {
      const patch = extractStringArg(argsJson, ["patch"]);
      const match = patch.match(/^diff --git a\/(.+?) b\//m);
      return match ? match[1] : "(patch)";
    }
    case "propose_shell": {
      const cmd = extractStringArg(argsJson, ["shell"]);
      return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
    }
    case "task": {
      const role = extractStringArg(argsJson, ["role"]);
      const description = extractStringArg(argsJson, ["description"]);
      return role ? `${role}: ${description.slice(0, 30)}...` : "";
    }
    case "update_plan": {
      const operation = extractStringArg(argsJson, ["operation"]);
      const stepId = extractStringArg(argsJson, ["step_id"]);
      return `${operation}: ${stepId}`.trim();
    }
    case "diagnostics":
      return argsJson.includes("\"changed_files\"") ? "changed files" : "(all)";
    case "fetch":
      return extractStringArg(argsJson, ["url"]).slice(0, 50);
    default:
      return "";
  }
}

function limitJsonField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[truncated]";
}

function smartTruncateWithHint(
  text: string,
  limit: number,
  hint: string,
  deps: ToolContentTrimDeps,
): { text: string; truncated: boolean; hint?: string } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const truncatedText = deps.smartTruncate(text, limit);
  return {
    text: truncatedText,
    truncated: true,
    hint,
  };
}

export function trimToolContentForContext(
  toolName: string,
  jsonText: string,
  deps: ToolContentTrimDeps,
): string {
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

    if (toolName === "propose_shell") {
      if (typeof obj.stdout === "string") {
        obj.stdout = limitJsonField(
          obj.stdout,
          MAX_SHELL_TOOL_PREVIEW_CHARS
        );
      }
      if (typeof obj.stderr === "string") {
        obj.stderr = limitJsonField(
          obj.stderr,
          MAX_SHELL_TOOL_PREVIEW_CHARS
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
      `tool(${toolName}) 输出过长，已做硬裁剪。`,
      deps,
    );
    return hard.text;
  } catch {
    // Not JSON or parse failed: fallback to char cap
    const hard = smartTruncateWithHint(
      jsonText,
      MAX_TOOL_OUTPUT_CHARS,
      `tool(${toolName}) 输出过长，已做硬裁剪。`,
      deps,
    );
    return hard.text;
  }
}
