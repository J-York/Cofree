export type ShellExecutionMode = "foreground" | "background";

export const DEFAULT_BACKGROUND_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_SHELL_OUTPUT_PREVIEW_CHARS = 12_000;
export const DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES = 16_384;
export const DEFAULT_SHELL_OUTPUT_FLUSH_INTERVAL_MS = 250;

/** Default block_until_ms for general foreground commands */
export const DEFAULT_BLOCK_UNTIL_MS = 30_000;
/**
 * For install/build commands that are expected to terminate.
 * Must be strictly less than SHELL_TIMEOUT_DEFAULT_MS (120 000) so the JS
 * deadline fires before the Rust hard-kill, giving the command a chance to
 * actually complete before being reported as moved_to_background.
 * The caller (autoExecuteShellProposal) raises timeoutMs to
 * INSTALL_BUILD_TIMEOUT_MS when blockUntilMs equals this value.
 */
export const INSTALL_BUILD_BLOCK_UNTIL_MS = 90_000;
/**
 * Hard timeout used for install/build commands when the auto-executor raises
 * it above the default 120 s to give the deadline room to fire first.
 */
export const INSTALL_BUILD_TIMEOUT_MS = 600_000;
/** For service/server commands — wait just long enough to see startup output */
export const SERVICE_BLOCK_UNTIL_MS = 15_000;

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

/**
 * Patterns for install/build commands that are expected to terminate eventually
 * but may take a long time. Give them a longer block window.
 */
const INSTALL_BUILD_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+install\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|add|remove|uninstall|update)\b/i,
  /\bpip(?:\d+)?\s+install\b/i,
  /\bcargo\s+(?:build|install|fetch|update)\b/i,
  /\bgo\s+(?:build|install|get|mod\s+download)\b/i,
  /\bmvn\s+(?:install|package|compile|dependency:resolve)\b/i,
  /\bgradle\s+(?:build|assemble|dependencies)\b/i,
  /\bapt(?:-get)?\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bdocker\s+(?:build|pull)\b/i,
  /\bmake\b/i,
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

/**
 * Infer an appropriate block_until_ms for a foreground shell command.
 *
 * - Service/server commands (npm run dev, vite, etc.) use a short window
 *   so the agent doesn't block forever waiting for an exit that will never come.
 * - Install/build commands use a longer window since they are expected to
 *   terminate but may take several minutes.
 * - Everything else gets the general default.
 *
 * The caller may pass an explicit value to override.
 */
export function inferBlockUntilMs(shell: string, explicitValue?: unknown): number {
  if (typeof explicitValue === "number" && Number.isFinite(explicitValue) && explicitValue >= 1000) {
    return Math.min(600_000, Math.round(explicitValue));
  }
  const normalized = shell.trim();
  if (BACKGROUND_COMMAND_PATTERNS.some((p) => p.test(normalized))) {
    return SERVICE_BLOCK_UNTIL_MS;
  }
  if (INSTALL_BUILD_PATTERNS.some((p) => p.test(normalized))) {
    return INSTALL_BUILD_BLOCK_UNTIL_MS;
  }
  return DEFAULT_BLOCK_UNTIL_MS;
}

/**
 * Result type for awaitShellCommandWithDeadline.
 * When the command completes before the deadline, result is a normal
 * CommandExecutionResult. When the deadline fires first, moved_to_background
 * is true and only partial output collected so far is included.
 */
export interface ShellDeadlineResult {
  /** True when the command was still running when block_until_ms elapsed */
  moved_to_background: boolean;
  job_id?: string;
  /** Partial stdout collected before deadline (only set when moved_to_background) */
  partial_stdout?: string;
  /** Partial stderr collected before deadline (only set when moved_to_background) */
  partial_stderr?: string;
  /** Normal completion fields (only set when moved_to_background is false) */
  success?: boolean;
  command?: string;
  timed_out?: boolean;
  status?: number;
  stdout?: string;
  stderr?: string;
  cancelled?: boolean;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}
