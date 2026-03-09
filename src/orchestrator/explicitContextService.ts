import type { AppSettings } from "../lib/settingsStore";
import { globWorkspaceFiles, readWorkspaceFile } from "../lib/tauriBridge";
import type { CofreeRcConfig } from "../lib/cofreerc";
import { resolveMatchingContextRules } from "../lib/cofreerc";
import {
  dedupeContextAttachments,
  type ChatContextAttachment,
} from "../lib/contextAttachments";
import { estimateTokensFromText } from "./contextBudget";

const MAX_CONTEXT_ATTACHMENTS = 8;
const MIN_ATTACHMENT_BUDGET_TOKENS = 800;
const MAX_ATTACHMENT_BUDGET_TOKENS = 5000;
const MAX_FOLDER_SAMPLE_FILES = 4;
const MAX_RULE_CONTEXT_FILES = 6;
const MIN_RULE_BUDGET_TOKENS = 400;
const MAX_RULE_BUDGET_TOKENS = 2400;

function truncateWithMarker(text: string, maxChars: number, marker: string): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const sliceLen = Math.max(0, maxChars - marker.length);
  return text.slice(0, sliceLen) + marker;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "无法读取";
}

function normalizeFolderPattern(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${normalized}/**/*` : "**/*";
}

async function buildFileSection(params: {
  attachment: ChatContextAttachment;
  workspacePath: string;
  perAttachmentLineBudget: number;
  perAttachmentCharBudget: number;
  ignorePatterns?: string[] | null;
}): Promise<string> {
  const result = await readWorkspaceFile({
    workspacePath: params.workspacePath,
    relativePath: params.attachment.relativePath,
    startLine: 1,
    endLine: params.perAttachmentLineBudget,
    ignorePatterns: params.ignorePatterns ?? undefined,
  });

  const baseContent = result.content.trimEnd();
  if (!baseContent) {
    return `--- ${params.attachment.relativePath} ---\n(文件为空)`;
  }

  let snippet = truncateWithMarker(
    baseContent,
    params.perAttachmentCharBudget,
    "\n... (内容已截断)",
  );
  const truncated =
    result.end_line < result.total_lines || snippet.length < baseContent.length;
  if (truncated && !snippet.endsWith("... (内容已截断)")) {
    snippet += "\n... (内容已截断)";
  }

  return [
    `--- ${params.attachment.relativePath} (lines 1-${result.end_line}${result.total_lines > 0 ? ` / ${result.total_lines}` : ""}) ---`,
    snippet,
  ].join("\n");
}

async function buildFolderSection(params: {
  attachment: ChatContextAttachment;
  workspacePath: string;
  perAttachmentLineBudget: number;
  perAttachmentCharBudget: number;
  ignorePatterns?: string[] | null;
}): Promise<string> {
  const entries = await globWorkspaceFiles({
    workspacePath: params.workspacePath,
    pattern: normalizeFolderPattern(params.attachment.relativePath),
    maxResults: 16,
    ignorePatterns: params.ignorePatterns ?? undefined,
  });
  if (entries.length === 0) {
    return `--- ${params.attachment.relativePath}/ ---\n(目录为空或无可读取文件)`;
  }

  const sampleFiles = entries.slice(0, MAX_FOLDER_SAMPLE_FILES);
  const perFileLineBudget = Math.max(20, Math.floor(params.perAttachmentLineBudget / sampleFiles.length));
  const perFileCharBudget = Math.max(320, Math.floor(params.perAttachmentCharBudget / sampleFiles.length));
  const parts: string[] = [
    `--- ${params.attachment.relativePath}/ ---`,
    `目录样本文件（展示 ${sampleFiles.length}/${entries.length} 个）：`,
    ...sampleFiles.map((entry) => `- ${entry.path}`),
  ];

  for (const entry of sampleFiles) {
    try {
      const readResult = await readWorkspaceFile({
        workspacePath: params.workspacePath,
        relativePath: entry.path,
        startLine: 1,
        endLine: perFileLineBudget,
        ignorePatterns: params.ignorePatterns ?? undefined,
      });
      const content = truncateWithMarker(
        readResult.content.trimEnd() || "(文件为空)",
        perFileCharBudget,
        "\n... (内容已截断)",
      );
      parts.push(
        [
          `>>> ${entry.path} (lines 1-${readResult.end_line}${readResult.total_lines > 0 ? ` / ${readResult.total_lines}` : ""})`,
          content,
        ].join("\n"),
      );
    } catch (error) {
      parts.push(`>>> ${entry.path}\n(读取失败：${stringifyError(error)})`);
    }
  }

  return parts.join("\n\n");
}

export async function buildMatchedContextRuleNote(params: {
  targetPaths: string[];
  settings: AppSettings;
  projectConfig?: CofreeRcConfig;
  ignorePatterns?: string[] | null;
  excludedPaths?: string[];
  heading?: string;
}): Promise<string> {
  const workspacePath = params.settings.workspacePath.trim();
  if (!workspacePath || !params.projectConfig?.contextRules?.length) {
    return "";
  }

  const uniqueTargets = [...new Set(
    params.targetPaths
      .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
      .filter(Boolean),
  )];
  if (uniqueTargets.length === 0) {
    return "";
  }

  const matchingRules = resolveMatchingContextRules(params.projectConfig, uniqueTargets);
  if (matchingRules.length === 0) {
    return "";
  }

  const maxContextTokens =
    params.settings.maxContextTokens > 0 ? params.settings.maxContextTokens : 128000;
  const ruleBudgetTokens = Math.min(
    MAX_RULE_BUDGET_TOKENS,
    Math.max(MIN_RULE_BUDGET_TOKENS, Math.floor(maxContextTokens * 0.05)),
  );
  const perFileLineBudget = Math.max(24, Math.floor(params.settings.maxSnippetLines / 2));
  const perFileCharBudget = Math.max(500, ruleBudgetTokens * 3);
  const excludedPaths = new Set((params.excludedPaths ?? []).map((path) => path.trim().replace(/\\/g, "/")));
  const sections: string[] = [params.heading ?? "[匹配的项目规则]"];
  const failures: string[] = [];

  sections.push(
    ...matchingRules.map((rule) => {
      const label = rule.id ? `${rule.id}` : "path-rule";
      const pathHint = rule.paths?.length ? ` [paths: ${rule.paths.join(", ")}]` : "";
      return `- ${label}${pathHint}: ${rule.instructions ?? "(无额外说明)"}`;
    }),
  );

  const supplementalFiles = [...new Set(
    matchingRules
      .flatMap((rule) => rule.contextFiles ?? [])
      .map((path) => path.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
      .filter((path) => path.length > 0 && !excludedPaths.has(path)),
  )].slice(0, MAX_RULE_CONTEXT_FILES);

  if (supplementalFiles.length > 0) {
    const supplementalSections: string[] = ["[规则补充文件]"];
    for (const relativePath of supplementalFiles) {
      try {
        supplementalSections.push(
          await buildFileSection({
            attachment: {
              id: `rule-${relativePath}`,
              kind: "file",
              source: "mention",
              relativePath,
              displayName: relativePath,
              addedAt: "",
            },
            workspacePath,
            perAttachmentLineBudget: perFileLineBudget,
            perAttachmentCharBudget: perFileCharBudget,
            ignorePatterns: params.ignorePatterns,
          }),
        );
      } catch (error) {
        failures.push(`${relativePath}（${stringifyError(error)}）`);
      }
    }
    sections.push(supplementalSections.join("\n\n"));
  }

  if (failures.length > 0) {
    sections.push(["[未能附加的规则路径]", ...failures.map((line) => `- ${line}`)].join("\n"));
  }

  let note = sections.join("\n\n");
  if (estimateTokensFromText(note) > ruleBudgetTokens) {
    note = truncateWithMarker(
      note,
      ruleBudgetTokens * 4,
      "\n\n... (命中的项目规则已按预算截断)",
    );
  }
  return note;
}

export async function buildExplicitContextNote(params: {
  attachments: ChatContextAttachment[];
  settings: AppSettings;
  ignorePatterns?: string[] | null;
  projectConfig?: CofreeRcConfig;
}): Promise<string> {
  const { settings, ignorePatterns } = params;
  const workspacePath = settings.workspacePath.trim();
  if (!workspacePath) {
    return "";
  }

  const attachments = dedupeContextAttachments(params.attachments).slice(
    0,
    MAX_CONTEXT_ATTACHMENTS,
  );
  if (attachments.length === 0) {
    return "";
  }

  const maxContextTokens =
    settings.maxContextTokens > 0 ? settings.maxContextTokens : 128000;
  const attachmentBudgetTokens = Math.min(
    MAX_ATTACHMENT_BUDGET_TOKENS,
    Math.max(MIN_ATTACHMENT_BUDGET_TOKENS, Math.floor(maxContextTokens * 0.12)),
  );
  const perAttachmentBudgetTokens = Math.max(
    220,
    Math.floor((attachmentBudgetTokens - 120) / attachments.length),
  );
  const perAttachmentLineBudget = Math.max(
    40,
    Math.floor(settings.maxSnippetLines / Math.max(1, Math.min(attachments.length, 4))),
  );
  const perAttachmentCharBudget = Math.max(500, perAttachmentBudgetTokens * 4);

  const sections: string[] = [
    "[用户显式上下文]",
    "以下文件或目录由用户通过 @ 主动加入本轮上下文。优先参考它们；若片段被截断，请继续使用 read_file 读取所需区域。",
  ];
  const failures: string[] = [];
  const matchingRuleTargets = attachments.flatMap((attachment) =>
    attachment.kind === "folder"
      ? [attachment.relativePath, `${attachment.relativePath}/**/*`]
      : [attachment.relativePath],
  );
  const matchedRuleNote = await buildMatchedContextRuleNote({
    targetPaths: matchingRuleTargets,
    settings,
    projectConfig: params.projectConfig,
    ignorePatterns,
    excludedPaths: attachments.map((attachment) => attachment.relativePath),
  });
  if (matchedRuleNote) {
    sections.push(matchedRuleNote);
  }

  for (const attachment of attachments) {
    try {
      sections.push(
        attachment.kind === "folder"
          ? await buildFolderSection({
            attachment,
            workspacePath,
            perAttachmentLineBudget,
            perAttachmentCharBudget,
            ignorePatterns,
          })
          : await buildFileSection({
            attachment,
            workspacePath,
            perAttachmentLineBudget,
            perAttachmentCharBudget,
            ignorePatterns,
          }),
      );
    } catch (error) {
      failures.push(
        `${attachment.relativePath}${attachment.kind === "folder" ? "/" : ""}（${stringifyError(error)}）`,
      );
    }
  }

  if (failures.length > 0) {
    sections.push(["[未能附加的路径]", ...failures.map((line) => `- ${line}`)].join("\n"));
  }

  let note = sections.join("\n\n");
  if (estimateTokensFromText(note) > attachmentBudgetTokens) {
    note = truncateWithMarker(
      note,
      attachmentBudgetTokens * 4,
      "\n\n... (显式上下文已按预算截断，必要时请继续使用 read_file)",
    );
  }
  return note;
}
