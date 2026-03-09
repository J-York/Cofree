/**
 * Shared helpers for workspace-scoped local storage namespaces.
 */

/**
 * djb2 hash of a string, returned as a short base36 string.
 * Falls back to "default" if path is empty/undefined.
 */
export function workspaceHash(workspacePath: string): string {
  if (!workspacePath) return "default";
  let hash = 5381;
  for (let i = 0; i < workspacePath.length; i++) {
    hash = ((hash << 5) + hash + workspacePath.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
