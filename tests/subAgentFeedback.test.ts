import { describe, expect, it } from "vitest";
import { tryExtractFeedback } from "../src/agents/structuredOutput";

describe("tryExtractFeedback", () => {
  it("extracts need_clarification status with feedback", () => {
    const reply = `我无法完成这个任务，需要更多信息。

\`\`\`json
{
  "status": "need_clarification",
  "reason": "缺少数据库配置信息",
  "missingContext": ["database.config.ts", "env.example"],
  "suggestedAction": "请提供数据库连接配置"
}
\`\`\``;

    const result = tryExtractFeedback(reply);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe("need_clarification");
    expect(result!.feedback).toBeDefined();
    expect(result!.feedback!.reason).toBe("缺少数据库配置信息");
    expect(result!.feedback!.missingContext).toEqual(["database.config.ts", "env.example"]);
    expect(result!.feedback!.suggestedAction).toBe("请提供数据库连接配置");
  });

  it("extracts blocked status with blockedBy", () => {
    const reply = `遇到阻塞。

\`\`\`json
{
  "status": "blocked",
  "reason": "需要先安装依赖",
  "blockedBy": "缺少 node_modules",
  "suggestedAction": "先执行 npm install"
}
\`\`\``;

    const result = tryExtractFeedback(reply);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe("blocked");
    expect(result!.feedback!.blockedBy).toBe("缺少 node_modules");
  });

  it("extracts partial status", () => {
    const reply = '```json\n{"status": "partial", "reason": "部分完成"}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe("partial");
    expect(result!.feedback!.reason).toBe("部分完成");
  });

  it("extracts failed status", () => {
    const reply = '```json\n{"status": "failed", "reason": "无法访问文件"}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe("failed");
  });

  it("returns undefined for completed status", () => {
    const reply = '```json\n{"status": "completed", "reason": "done"}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no JSON block", () => {
    const result = tryExtractFeedback("Just a plain text reply.");
    expect(result).toBeUndefined();
  });

  it("returns undefined when JSON has no status field", () => {
    const reply = '```json\n{"tasks": [{"title": "test"}]}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid status value", () => {
    const reply = '```json\n{"status": "unknown_status", "reason": "test"}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const reply = '```json\n{bad json}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).toBeUndefined();
  });

  it("provides default reason when missing", () => {
    const reply = '```json\n{"status": "blocked"}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).not.toBeUndefined();
    expect(result!.feedback!.reason).toBe("未提供原因");
  });

  it("handles missingContext as non-array gracefully", () => {
    const reply = '```json\n{"status": "need_clarification", "reason": "test", "missingContext": "not-array"}\n```';
    const result = tryExtractFeedback(reply);
    expect(result).not.toBeUndefined();
    expect(result!.feedback!.missingContext).toBeUndefined();
  });
});
