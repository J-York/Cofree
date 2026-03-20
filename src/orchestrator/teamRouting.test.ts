import { describe, expect, it } from "vitest";
import { countRepairStages, decideTeamRouting } from "./teamRouting";

describe("teamRouting", () => {
  it("defaults to builtin pipeline", () => {
    expect(decideTeamRouting({ teamId: "t", repairRoundsUsed: 0 })).toEqual({
      mode: "builtin_pipeline",
    });
  });

  it("counts repair stages heuristically", () => {
    expect(
      countRepairStages({
        审查问题修复: { status: "completed", turnCount: 2 },
        测试失败修复: { status: "skipped", turnCount: 0 },
      }),
    ).toBe(1);
  });
});
