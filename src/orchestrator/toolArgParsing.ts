/**
 * Pure argument-coercion helpers used by tool handlers.
 *
 * Tool arguments arrive as `Record<string, unknown>` parsed from JSON, so
 * every call site must normalize them before use.  Keeping these helpers
 * together makes the coercion rules auditable and unit-testable in
 * isolation — without pulling the Tauri invoke surface area into the test.
 */

export function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Strip line-number prefixes that read_file adds (e.g. "487│  code" → "  code").
 * Models may accidentally copy these into search/anchor fields.
 */
export function stripLineNumberPrefixes(text: string): string {
  // \s* handles optional leading spaces that some models copy from the display format (e.g. "  10│")
  return text.replace(/^\s*[0-9]+│/gm, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

export function countOccurrences(content: string, snippet: string): number {
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
