/**
 * Auto-execution helpers for sensitive proposals that the approval resolver
 * has already green-lit (either via workspace rule match or tool-permission
 * auto level).
 *
 * These run the action *without* the HITL gate, so keep them narrow and
 * defensive:
 *   - Patch path takes a snapshot before applying so a failed patch can
 *     roll the working tree back.
 *   - Shell path promotes background execution at the configured
 *     `blockUntilMs` threshold and normalizes the JSON payload the LLM
 *     sees afterwards.
 */

import { invoke } from "@tauri-apps/api/core";
import { awaitShellCommandWithDeadline } from "../lib/tauriBridge";
import {
  DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
  INSTALL_BUILD_BLOCK_UNTIL_MS,
  INSTALL_BUILD_TIMEOUT_MS,
} from "../lib/shellCommand";
import type { ToolExecutionResult } from "./toolExecutor";

interface PatchApplyResult {
  success: boolean;
  message: string;
  files: string[];
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

export async function fetchPostPatchDiagnostics(
  workspacePath: string,
  changedFiles: string[],
): Promise<{ hasDiagnostics: boolean; summary: string }> {
  try {
    const result = await invoke<DiagnosticsResult>(
      "get_workspace_diagnostics",
      {
        workspacePath,
        changedFiles,
      },
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
        `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.message}`,
    );
    const summary = `[诊断反馈 via ${result.tool_used}] 发现 ${result.diagnostics.length} 个问题:\n${lines.join("\n")}`;
    return { hasDiagnostics: true, summary };
  } catch {
    return { hasDiagnostics: false, summary: "" };
  }
}

export async function autoExecutePatchProposal(params: {
  workspacePath: string;
  patch: string;
  responseMeta?: Record<string, unknown>;
  autoApprovalMeta?: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const snapshot = await invoke<{
    success: boolean;
    snapshot_id: string;
    files: string[];
  }>("create_workspace_snapshot", {
    workspacePath: params.workspacePath,
    patch: params.patch,
  });
  const applyResult = await invoke<PatchApplyResult>(
    "apply_workspace_patch",
    { workspacePath: params.workspacePath, patch: params.patch },
  );
  if (!applyResult.success && snapshot.success) {
    await invoke<PatchApplyResult>("restore_workspace_snapshot", {
      workspacePath: params.workspacePath,
      snapshotId: snapshot.snapshot_id,
    });
  }

  const responsePayload: Record<string, unknown> = {
    ok: applyResult.success,
    action_type: "apply_patch",
    auto_executed: true,
    patch_length: params.patch.length,
    files: applyResult.files,
    message: applyResult.message,
    ...(params.responseMeta ?? {}),
    ...(params.autoApprovalMeta ?? {}),
  };
  if (applyResult.success) {
    const diagnostics = await fetchPostPatchDiagnostics(
      params.workspacePath,
      applyResult.files,
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

export async function autoExecuteShellProposal(params: {
  workspacePath: string;
  shell: string;
  timeoutMs: number;
  blockUntilMs: number;
  autoApprovalMeta?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ToolExecutionResult> {
  // For install/build commands the default blockUntilMs is 90 000 ms.
  // If the caller left timeoutMs at the default (120 000), the JS deadline and
  // the Rust hard-kill would fire almost simultaneously. Raise the hard timeout
  // so the command keeps running in the background after the deadline.
  const effectiveTimeoutMs =
    params.blockUntilMs === INSTALL_BUILD_BLOCK_UNTIL_MS &&
    params.timeoutMs <= INSTALL_BUILD_BLOCK_UNTIL_MS
      ? INSTALL_BUILD_TIMEOUT_MS
      : Math.max(params.timeoutMs, params.blockUntilMs + 5_000);

  const deadlineResult = await awaitShellCommandWithDeadline({
    workspacePath: params.workspacePath,
    shell: params.shell,
    timeoutMs: effectiveTimeoutMs,
    blockUntilMs: params.blockUntilMs,
    maxOutputBytes: DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
    signal: params.signal,
  });

  if (deadlineResult.moved_to_background) {
    return {
      content: JSON.stringify({
        ok: true,
        action_type: "shell",
        auto_executed: true,
        shell: params.shell,
        moved_to_background: true,
        job_id: deadlineResult.job_id,
        stdout: deadlineResult.partial_stdout,
        stderr: deadlineResult.partial_stderr,
        exit_code: null,
        timed_out: false,
        message: `命令在 ${params.blockUntilMs}ms 内未完成，已自动转为后台运行。如需检查进程状态，可使用 propose_shell(shell='kill -0 <pid>') 或重新运行相关命令。`,
        ...(params.autoApprovalMeta ?? {}),
      }),
      success: true,
    };
  }

  const cmdResult = deadlineResult.result;

  return {
    content: JSON.stringify({
      ok: cmdResult.success,
      action_type: "shell",
      auto_executed: true,
      shell: params.shell,
      stdout: cmdResult.stdout,
      stderr: cmdResult.stderr,
      stdout_truncated: cmdResult.stdout_truncated ?? false,
      stderr_truncated: cmdResult.stderr_truncated ?? false,
      stdout_total_bytes: cmdResult.stdout_total_bytes ?? cmdResult.stdout.length,
      stderr_total_bytes: cmdResult.stderr_total_bytes ?? cmdResult.stderr.length,
      output_limit_bytes:
        cmdResult.output_limit_bytes ?? DEFAULT_SHELL_OUTPUT_CAPTURE_MAX_BYTES,
      exit_code: cmdResult.status,
      timed_out: cmdResult.timed_out,
      ...(params.autoApprovalMeta ?? {}),
    }),
    success: cmdResult.success,
    errorCategory: cmdResult.success ? undefined : "validation",
    errorMessage: cmdResult.success
      ? undefined
      : `命令执行失败 (exit ${cmdResult.status})`,
  };
}
