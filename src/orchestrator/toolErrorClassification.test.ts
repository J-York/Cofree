import { describe, expect, it } from "vitest";
import {
  buildToolErrorRecoveryHint,
  classifyToolError,
  computeToolRetryDelay,
  shouldRetryToolCall,
} from "./toolErrorClassification";

describe("classifyToolError", () => {
  it.each([
    ["relative_path 不能为空", "validation"],
    ["Invalid JSON arguments", "validation"],
    ["search 片段未找到: foo.ts", "validation"],
    ["search 片段出现多次（3 次）", "validation"],
    ["Patch 预检失败: corrupt patch", "validation"],
    ["目标文件已存在", "validation"],
    ["编辑结果为空，未产生文件变更", "validation"],
    ["不支持的 file edit operation: foo", "validation"],
    ["行号超出文件范围", "validation"],
    ["文件为空，无法按行定位编辑", "validation"],
    ["Invalid target path", "validation"],
    ["No such file or directory", "validation"],
    ["line 超出文件范围", "validation"],
    ["patch does not apply", "validation"],
    ["corrupt patch received", "validation"],
  ])("classifies %p as validation", (msg, expected) => {
    expect(classifyToolError(msg)).toBe(expected);
  });

  it("classifies workspace errors", () => {
    expect(classifyToolError("未选择工作区")).toBe("workspace");
    expect(classifyToolError("workspace path missing")).toBe("workspace");
  });

  it.each([
    ["Command rejected by allowlist", "guardrail"],
    ["guardrail triggered", "guardrail"],
    ["shell 控制符被禁止", "guardrail"],
    ["工作区越界路径", "guardrail"],
    ["受限目录", "guardrail"],
    ["命中被禁止的可执行程序", "guardrail"],
    ["命中高风险关键字", "guardrail"],
    ["解释器内联执行禁止", "guardrail"],
    ["请使用 propose_apply_patch 工具", "guardrail"],
    ["禁止直接改文件", "guardrail"],
  ])("classifies %p as guardrail", (msg, expected) => {
    expect(classifyToolError(msg)).toBe(expected);
  });

  it("classifies timeout errors", () => {
    expect(classifyToolError("operation timed out")).toBe("timeout");
    expect(classifyToolError("调用超时")).toBe("timeout");
  });

  it("classifies permission errors", () => {
    expect(classifyToolError("permission denied")).toBe("permission");
    expect(classifyToolError("operation not permitted")).toBe("permission");
  });

  it("classifies tool_not_found for 未知工具", () => {
    expect(classifyToolError("未知工具: foobar")).toBe("tool_not_found");
  });

  it.each([
    ["fetch failed", "transport"],
    ["network error", "transport"],
    ["http 503", "transport"],
  ])("classifies %p as transport", (msg, expected) => {
    expect(classifyToolError(msg)).toBe(expected);
  });

  it("falls back to unknown for unmatched messages", () => {
    expect(classifyToolError("something weird happened")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyToolError("NO SUCH FILE OR DIRECTORY")).toBe("validation");
    expect(classifyToolError("TIMED OUT")).toBe("timeout");
  });

  it("checks validation before guardrail when both keywords match", () => {
    // "propose_apply_patch" is a guardrail keyword but "预检失败" wins (listed first in code)
    expect(classifyToolError("Patch 预检失败: propose_apply_patch 仅允许单文件")).toBe(
      "validation",
    );
  });
});

describe("shouldRetryToolCall", () => {
  it("retries transient categories", () => {
    expect(shouldRetryToolCall("transport")).toBe(true);
    expect(shouldRetryToolCall("timeout")).toBe(true);
    expect(shouldRetryToolCall("workspace")).toBe(true);
    expect(shouldRetryToolCall("unknown")).toBe(true);
  });

  it("does not retry deterministic failures", () => {
    expect(shouldRetryToolCall("validation")).toBe(false);
    expect(shouldRetryToolCall("permission")).toBe(false);
    expect(shouldRetryToolCall("allowlist")).toBe(false);
    expect(shouldRetryToolCall("guardrail")).toBe(false);
    expect(shouldRetryToolCall("tool_not_found")).toBe(false);
  });
});

describe("computeToolRetryDelay", () => {
  it("grows exponentially with attempt count", () => {
    // Base delay 500ms, 20% jitter. Attempt N gets 500 * 2^(N-1) + jitter.
    const attempt1 = computeToolRetryDelay(1);
    expect(attempt1).toBeGreaterThanOrEqual(500);
    expect(attempt1).toBeLessThanOrEqual(600);

    const attempt2 = computeToolRetryDelay(2);
    expect(attempt2).toBeGreaterThanOrEqual(1000);
    expect(attempt2).toBeLessThanOrEqual(1200);

    const attempt3 = computeToolRetryDelay(3);
    expect(attempt3).toBeGreaterThanOrEqual(2000);
    expect(attempt3).toBeLessThanOrEqual(2400);
  });

  it("caps at maxDelayMs (5000ms)", () => {
    // Base 500ms, 10 attempts → 500 * 512 = 256000ms before cap
    const attempt10 = computeToolRetryDelay(10);
    expect(attempt10).toBeLessThanOrEqual(5000);
  });
});

describe("buildToolErrorRecoveryHint", () => {
  it("includes tool name, category, and message in every hint", () => {
    const hint = buildToolErrorRecoveryHint(
      "read_file",
      "validation",
      "relative_path 不能为空",
    );
    expect(hint).toContain('工具 "read_file" 执行失败');
    expect(hint).toContain("错误类别: validation");
    expect(hint).toContain("relative_path 不能为空");
  });

  it("attaches validation-specific guidance", () => {
    const hint = buildToolErrorRecoveryHint("propose_file_edit", "validation", "err");
    expect(hint).toContain("参数格式或值不正确");
    expect(hint).toContain("relative_path 必须是工作区相对路径");
  });

  it("attaches workspace-specific guidance", () => {
    const hint = buildToolErrorRecoveryHint("list_files", "workspace", "err");
    expect(hint).toContain("工作区操作失败");
    expect(hint).toContain("list_files 或 glob");
  });

  it("attaches timeout-specific guidance", () => {
    const hint = buildToolErrorRecoveryHint("propose_shell", "timeout", "err");
    expect(hint).toContain("操作超时");
    expect(hint).toContain("timeout_ms");
  });

  it("attaches transport guidance (auto-retry note)", () => {
    const hint = buildToolErrorRecoveryHint("fetch", "transport", "err");
    expect(hint).toContain("网络或传输错误");
    expect(hint).toContain("自动重试");
  });

  it("attaches tool_not_found guidance", () => {
    const hint = buildToolErrorRecoveryHint("bogus", "tool_not_found", "err");
    expect(hint).toContain("调用了不存在的工具");
  });

  it("shares guidance across permission / allowlist / guardrail categories", () => {
    const perm = buildToolErrorRecoveryHint("propose_shell", "permission", "err");
    const allow = buildToolErrorRecoveryHint("propose_shell", "allowlist", "err");
    const guard = buildToolErrorRecoveryHint("propose_shell", "guardrail", "err");
    for (const hint of [perm, allow, guard]) {
      expect(hint).toContain("权限或安全策略阻止了此操作");
    }
  });

  it("falls back to unknown guidance for unclassified categories", () => {
    const hint = buildToolErrorRecoveryHint("x", "unknown", "err");
    expect(hint).toContain("发生未知错误");
  });
});
