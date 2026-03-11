export type ShellExecutionMode = "foreground" | "background";

export const DEFAULT_BACKGROUND_READY_TIMEOUT_MS = 20_000;

const LOCAL_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s'"]*)?/i;

const BACKGROUND_COMMAND_PATTERNS: RegExp[] = [
  /\bpython(?:\d+(?:\.\d+)*)?\s+-m\s+http\.server\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|start)\b/i,
  /\bvite(?:\s+(?:dev|serve|preview)|\s*$)/i,
  /\bnext\s+dev\b/i,
  /\bwebpack(?:-dev-server)?\s+serve\b/i,
  /\buvicorn\b/i,
  /\bflask\s+run\b/i,
  /\bdjango-admin\s+runserver\b/i,
  /\bmanage\.py\s+runserver\b/i,
  /\brails\s+(?:s|server)\b/i,
  /\bdocker(?:-compose|\s+compose)\s+up\b/i,
  /\bdeno\s+task\s+(?:dev|serve|start)\b/i,
];

const PORT_PATTERNS: RegExp[] = [
  /\bhttp\.server\s+(\d{2,5})\b/i,
  /\b(?:--port|-p)\s+(\d{2,5})\b/i,
  /\bPORT=(\d{2,5})\b/,
  /\blocalhost:(\d{2,5})\b/i,
  /\b127\.0\.0\.1:(\d{2,5})\b/i,
  /\b0\.0\.0\.0:(\d{2,5})\b/i,
];

function normalizeLocalUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace("0.0.0.0", "127.0.0.1");
}

function extractPort(shell: string): string | null {
  for (const pattern of PORT_PATTERNS) {
    const match = shell.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function isShellExecutionMode(value: unknown): value is ShellExecutionMode {
  return value === "foreground" || value === "background";
}

export function isLikelyBackgroundShellCommand(shell: string): boolean {
  const normalized = shell.trim();
  if (!normalized) {
    return false;
  }
  return BACKGROUND_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function resolveShellExecutionMode(
  shell: string,
  preferredMode?: unknown,
): ShellExecutionMode {
  if (isShellExecutionMode(preferredMode)) {
    return preferredMode;
  }
  return isLikelyBackgroundShellCommand(shell) ? "background" : "foreground";
}

export function extractShellReadyUrlFromText(text: string): string | undefined {
  const match = text.match(LOCAL_URL_PATTERN);
  return match?.[0] ? normalizeLocalUrl(match[0]) : undefined;
}

export function inferShellReadyUrl(shell: string): string | undefined {
  const explicit = extractShellReadyUrlFromText(shell);
  if (explicit) {
    return explicit;
  }

  const port = extractPort(shell);
  if (!port) {
    return undefined;
  }
  return `http://127.0.0.1:${port}`;
}

export function resolveShellReadyUrl(params: {
  shell: string;
  preferredUrl?: unknown;
  executionMode: ShellExecutionMode;
}): string | undefined {
  if (typeof params.preferredUrl === "string" && params.preferredUrl.trim()) {
    return normalizeLocalUrl(params.preferredUrl);
  }
  if (params.executionMode !== "background") {
    return undefined;
  }
  return inferShellReadyUrl(params.shell);
}

export function resolveShellReadyTimeoutMs(
  value: unknown,
  executionMode: ShellExecutionMode,
): number | undefined {
  if (executionMode !== "background") {
    return undefined;
  }
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : DEFAULT_BACKGROUND_READY_TIMEOUT_MS;
  return Math.min(120_000, Math.max(1_000, numeric));
}
