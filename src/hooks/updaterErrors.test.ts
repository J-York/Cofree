import { describe, expect, it } from "vitest";
import { classifyUpdateError } from "./updaterErrors";

describe("classifyUpdateError", () => {
  it("surfaces signature verification failures instead of hiding them", () => {
    expect(classifyUpdateError(new Error("signature verify failed"))).toEqual({
      kind: "verification",
      message: "自动更新签名校验失败，请联系开发者检查发布签名或更新公钥。",
    });
  });

  it("keeps installer failures actionable", () => {
    expect(classifyUpdateError(new Error("permission denied while replace app bundle"))).toEqual({
      kind: "install",
      message: "更新包已下载，但安装失败。请关闭应用后手动安装，或稍后重试。",
    });
  });

  it("passes through unknown messages for debugging", () => {
    expect(classifyUpdateError(new Error("gateway timeout"))).toEqual({
      kind: "generic",
      message: "gateway timeout",
    });
  });
});
