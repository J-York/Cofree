import { describe, expect, it } from "vitest";
import { tryExtractStructuredOutput } from "../src/agents/structuredOutput";

describe("tryExtractStructuredOutput", () => {
  describe("planner", () => {
    it("extracts valid planner output", () => {
      const reply = `分析完成。

\`\`\`json
{
  "tasks": [
    {
      "title": "重构认证模块",
      "description": "将认证逻辑从 app.ts 抽取到 auth.ts",
      "targetFiles": ["src/app.ts", "src/auth.ts"],
      "estimatedComplexity": "medium"
    },
    {
      "title": "添加单元测试",
      "description": "为新的认证模块编写测试",
      "targetFiles": ["tests/auth.test.ts"],
      "estimatedComplexity": "low"
    }
  ],
  "riskAssessment": "中等风险",
  "architectureNotes": "建议使用策略模式"
}
\`\`\``;

      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).not.toBeUndefined();
      expect(result!.role).toBe("planner");
      if (result!.role === "planner") {
        expect(result!.data.tasks).toHaveLength(2);
        expect(result!.data.tasks[0].title).toBe("重构认证模块");
        expect(result!.data.tasks[0].estimatedComplexity).toBe("medium");
        expect(result!.data.riskAssessment).toBe("中等风险");
        expect(result!.data.architectureNotes).toBe("建议使用策略模式");
      }
    });

    it("returns undefined for planner with no tasks", () => {
      const reply = '```json\n{"tasks": []}\n```';
      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).toBeUndefined();
    });

    it("returns undefined for planner with invalid tasks", () => {
      const reply = '```json\n{"tasks": "not an array"}\n```';
      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).toBeUndefined();
    });

    it("normalizes missing complexity to medium", () => {
      const reply = '```json\n{"tasks": [{"title": "Task 1", "description": "Do something", "targetFiles": []}]}\n```';
      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).not.toBeUndefined();
      if (result?.role === "planner") {
        expect(result.data.tasks[0].estimatedComplexity).toBe("medium");
      }
    });
  });

  describe("coder", () => {
    it("extracts valid coder output", () => {
      const reply = `实现完成。

\`\`\`json
{
  "changedFiles": ["src/auth.ts", "src/app.ts"],
  "summary": "将认证逻辑抽取到独立模块",
  "implementationNotes": "使用了策略模式",
  "knownIssues": ["缺少错误处理"]
}
\`\`\``;

      const result = tryExtractStructuredOutput("coder", reply);
      expect(result).not.toBeUndefined();
      expect(result!.role).toBe("coder");
      if (result!.role === "coder") {
        expect(result!.data.changedFiles).toEqual(["src/auth.ts", "src/app.ts"]);
        expect(result!.data.summary).toBe("将认证逻辑抽取到独立模块");
        expect(result!.data.knownIssues).toEqual(["缺少错误处理"]);
      }
    });

    it("returns undefined for coder without summary", () => {
      const reply = '```json\n{"changedFiles": ["a.ts"]}\n```';
      const result = tryExtractStructuredOutput("coder", reply);
      expect(result).toBeUndefined();
    });
  });

  describe("tester", () => {
    it("extracts valid tester output", () => {
      const reply = `测试分析完成。

\`\`\`json
{
  "testPlan": [
    {
      "testCase": "认证流程测试",
      "steps": ["调用 login()", "验证 token"],
      "expectedResult": "返回有效 token",
      "passed": true
    }
  ],
  "riskLevel": "low",
  "coverageGaps": ["错误路径未覆盖"]
}
\`\`\``;

      const result = tryExtractStructuredOutput("tester", reply);
      expect(result).not.toBeUndefined();
      expect(result!.role).toBe("tester");
      if (result!.role === "tester") {
        expect(result!.data.testPlan).toHaveLength(1);
        expect(result!.data.testPlan[0].testCase).toBe("认证流程测试");
        expect(result!.data.riskLevel).toBe("low");
        expect(result!.data.coverageGaps).toEqual(["错误路径未覆盖"]);
      }
    });

    it("returns undefined for tester with empty test plan", () => {
      const reply = '```json\n{"testPlan": [], "riskLevel": "low"}\n```';
      const result = tryExtractStructuredOutput("tester", reply);
      expect(result).toBeUndefined();
    });

    it("normalizes missing riskLevel to medium", () => {
      const reply = '```json\n{"testPlan": [{"testCase": "T1", "steps": [], "expectedResult": "OK"}]}\n```';
      const result = tryExtractStructuredOutput("tester", reply);
      expect(result).not.toBeUndefined();
      if (result?.role === "tester") {
        expect(result.data.riskLevel).toBe("medium");
      }
    });
  });

  describe("edge cases", () => {
    it("returns undefined when no JSON block found", () => {
      const result = tryExtractStructuredOutput("planner", "Just plain text, no JSON here.");
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid JSON", () => {
      const result = tryExtractStructuredOutput("planner", "```json\n{invalid json}\n```");
      expect(result).toBeUndefined();
    });

    it("handles multiple JSON blocks by taking the first", () => {
      const reply = `
\`\`\`json
{"tasks": [{"title": "First", "description": "d", "targetFiles": [], "estimatedComplexity": "low"}]}
\`\`\`

Some text

\`\`\`json
{"tasks": [{"title": "Second", "description": "d", "targetFiles": [], "estimatedComplexity": "high"}]}
\`\`\``;
      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).not.toBeUndefined();
      if (result?.role === "planner") {
        expect(result.data.tasks[0].title).toBe("First");
      }
    });

    it("handles JSON block with extra whitespace", () => {
      const reply = "```json\n\n  {\"tasks\": [{\"title\": \"T\", \"description\": \"d\", \"targetFiles\": []}]}  \n\n```";
      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).not.toBeUndefined();
    });

    it("returns undefined for empty JSON object", () => {
      const result = tryExtractStructuredOutput("planner", "```json\n{}\n```");
      expect(result).toBeUndefined();
    });

    it("returns undefined for non-object JSON value", () => {
      const result = tryExtractStructuredOutput("planner", '```json\n"string"\n```');
      expect(result).toBeUndefined();
    });

    it("handles tasks with missing title (filters them out)", () => {
      const reply = '```json\n{"tasks": [{"description": "no title"}, {"title": "Has title", "description": "d", "targetFiles": []}]}\n```';
      const result = tryExtractStructuredOutput("planner", reply);
      expect(result).not.toBeUndefined();
      if (result?.role === "planner") {
        expect(result.data.tasks).toHaveLength(1);
        expect(result.data.tasks[0].title).toBe("Has title");
      }
    });
  });
});
