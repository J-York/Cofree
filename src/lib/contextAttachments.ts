export type ChatContextAttachmentKind = "file" | "folder";
export type ChatContextAttachmentSource = "mention";

export interface ChatContextAttachment {
  id: string;
  kind: ChatContextAttachmentKind;
  source: ChatContextAttachmentSource;
  relativePath: string;
  displayName: string;
  addedAt: string;
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function normalizeAttachmentPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

export function createFileContextAttachment(relativePath: string): ChatContextAttachment {
  return createContextAttachment("file", relativePath);
}

export function createFolderContextAttachment(relativePath: string): ChatContextAttachment {
  return createContextAttachment("folder", relativePath);
}

function createContextAttachment(
  kind: ChatContextAttachmentKind,
  relativePath: string,
): ChatContextAttachment {
  const normalizedPath = normalizeAttachmentPath(relativePath);
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `ctx-${crypto.randomUUID()}`
        : `ctx-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    kind,
    source: "mention",
    relativePath: normalizedPath,
    displayName: basenameOf(normalizedPath),
    addedAt: new Date().toISOString(),
  };
}

export function normalizeContextAttachments(value: unknown): ChatContextAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ChatContextAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const relativePath =
      typeof record.relativePath === "string"
        ? normalizeAttachmentPath(record.relativePath)
        : "";
    if (!relativePath) {
      continue;
    }

    normalized.push({
      id: typeof record.id === "string" && record.id.trim() ? record.id : `ctx-${relativePath}`,
      kind: record.kind === "folder" ? "folder" : "file",
      source: record.source === "mention" ? "mention" : "mention",
      relativePath,
      displayName:
        typeof record.displayName === "string" && record.displayName.trim()
          ? record.displayName.trim()
          : basenameOf(relativePath),
      addedAt:
        typeof record.addedAt === "string" && record.addedAt.trim()
          ? record.addedAt
          : "",
    });

    if (normalized.length >= 20) {
      break;
    }
  }

  return dedupeContextAttachments(normalized);
}

export function dedupeContextAttachments(
  attachments: ChatContextAttachment[],
): ChatContextAttachment[] {
  const seen = new Set<string>();
  const result: ChatContextAttachment[] = [];

  for (const attachment of attachments) {
    const normalizedPath = normalizeAttachmentPath(attachment.relativePath);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    result.push({
      ...attachment,
      relativePath: normalizedPath,
      displayName: attachment.displayName?.trim() || basenameOf(normalizedPath),
    });
  }

  return result;
}

export function formatContextAttachmentManifest(
  attachments: ChatContextAttachment[],
): string {
  if (attachments.length === 0) {
    return "";
  }

  return [
    "[用户显式附加的上下文路径]",
    ...attachments.map((attachment) =>
      attachment.kind === "folder"
        ? `- [目录] ${attachment.relativePath}/`
        : `- [文件] ${attachment.relativePath}`,
    ),
  ].join("\n");
}
