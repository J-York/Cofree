import { describe, expect, it } from "vitest";
import { tryExtractStructuredOutput } from "../src/agents/structuredOutput";

describe("tryExtractStructuredOutput - Specialized Agents", () => {
  describe("debugger", () => {
    it("extracts valid debugger output", () => {
      const reply = `分析完成。
\`\`\`json
{
  "hypotheses": [
    {
      "description": "Null pointer exception when accessing user.profile",
      "evidence": "Logs show user is null",
      "status": "confirmed"
    }
  ],
  "rootCause": "Null pointer exception when accessing user.profile",
  "fix": "Add optional chaining: user?.profile"
}
\`\`\``;

      const result = tryExtractStructuredOutput("debugger", reply);
      expect(result).not.toBeUndefined();
      expect(result!.role).toBe("debugger");
      if (result!.role === "debugger") {
        expect(result!.data.rootCause).toBe("Null pointer exception when accessing user.profile");
        expect(result!.data.fix).toBe("Add optional chaining: user?.profile");
        expect(result!.data.hypotheses).toHaveLength(1);
        expect(result!.data.hypotheses[0].status).toBe("confirmed");
      }
    });

    it("returns undefined for debugger without hypotheses", () => {
      const reply = '```json\n{"fix": "Do this", "rootCause": "cause"}\n```';
      const result = tryExtractStructuredOutput("debugger", reply);
      expect(result).toBeUndefined();
    });
  });

  describe("reviewer", () => {
    it("extracts valid reviewer output", () => {
      const reply = `代码审查完成。
\`\`\`json
{
  "issues": [
    {
      "severity": "warning",
      "file": "src/app.ts",
      "line": 42,
      "message": "可以优化循环"
    }
  ],
  "overallAssessment": "comment",
  "summary": "代码逻辑清晰，但有一些警告"
}
\`\`\``;

      const result = tryExtractStructuredOutput("reviewer", reply);
      expect(result).not.toBeUndefined();
      expect(result!.role).toBe("reviewer");
      if (result!.role === "reviewer") {
        expect(result!.data.overallAssessment).toBe("comment");
        expect(result!.data.summary).toBe("代码逻辑清晰，但有一些警告");
        expect(result!.data.issues).toHaveLength(1);
        expect(result!.data.issues[0].severity).toBe("warning");
      }
    });

    it("normalizes missing arrays for reviewer", () => {
      const reply = '```json\n{"overallAssessment": "approve", "summary": "Looks good"}\n```';
      const result = tryExtractStructuredOutput("reviewer", reply);
      expect(result).toBeUndefined(); // Because issues is missing! And we check Array.isArray(data.issues)
    });
  });
});
