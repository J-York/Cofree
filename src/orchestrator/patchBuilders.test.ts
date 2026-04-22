import { describe, expect, it } from "vitest";
import {
  buildCreateFilePatch,
  formatUnifiedRange,
  insertByLine,
  replaceByLineRange,
  splitContentSegments,
  splitPatchLines,
} from "./patchBuilders";

describe("splitPatchLines", () => {
  it("returns empty structure for empty content", () => {
    expect(splitPatchLines("")).toEqual({
      lines: [],
      hasTrailingNewline: false,
    });
  });

  it("records the trailing newline and strips it from lines", () => {
    expect(splitPatchLines("a\nb\n")).toEqual({
      lines: ["a", "b"],
      hasTrailingNewline: true,
    });
  });

  it("notes missing trailing newline", () => {
    expect(splitPatchLines("a\nb")).toEqual({
      lines: ["a", "b"],
      hasTrailingNewline: false,
    });
  });

  it("treats a lone newline as one empty line", () => {
    expect(splitPatchLines("\n")).toEqual({
      lines: [""],
      hasTrailingNewline: true,
    });
  });
});

describe("splitContentSegments", () => {
  it("keeps the trailing newline inside each preceding segment", () => {
    expect(splitContentSegments("a\nb\n")).toEqual(["a\n", "b\n"]);
  });

  it("emits the dangling tail as its own segment when no final newline", () => {
    expect(splitContentSegments("a\nb")).toEqual(["a\n", "b"]);
  });

  it("returns empty array for empty content", () => {
    expect(splitContentSegments("")).toEqual([]);
  });
});

describe("replaceByLineRange", () => {
  it("replaces a single line preserving surrounding newlines", () => {
    expect(replaceByLineRange("a\nb\nc\n", 2, 2, "B\n")).toBe("a\nB\nc\n");
  });

  it("replaces a contiguous line range", () => {
    expect(replaceByLineRange("a\nb\nc\nd\n", 2, 3, "X\n")).toBe("a\nX\nd\n");
  });

  it("throws on empty content", () => {
    expect(() => replaceByLineRange("", 1, 1, "x")).toThrow(/文件为空/);
  });

  it("throws on inverted range", () => {
    expect(() => replaceByLineRange("a\nb\n", 2, 1, "x")).toThrow(/非法行号/);
  });

  it("throws on out-of-bound lines", () => {
    expect(() => replaceByLineRange("a\nb\n", 1, 5, "x")).toThrow(/超出文件范围/);
  });
});

describe("insertByLine", () => {
  it("inserts before the target line", () => {
    expect(insertByLine("a\nb\n", 2, "NEW\n", "before")).toBe("a\nNEW\nb\n");
  });

  it("inserts after the target line", () => {
    expect(insertByLine("a\nb\n", 1, "NEW\n", "after")).toBe("a\nNEW\nb\n");
  });

  it("appends at EOF when position=after on the last line", () => {
    expect(insertByLine("a\nb\n", 2, "NEW\n", "after")).toBe("a\nb\nNEW\n");
  });

  it("throws on empty content", () => {
    expect(() => insertByLine("", 1, "x", "before")).toThrow(/文件为空/);
  });

  it("throws when line exceeds the file length", () => {
    expect(() => insertByLine("a\n", 5, "x", "before")).toThrow(/line 超出/);
  });
});

describe("formatUnifiedRange", () => {
  it("emits just the start when count=1", () => {
    expect(formatUnifiedRange(10, 1)).toBe("10");
  });

  it("emits start,count when count != 1", () => {
    expect(formatUnifiedRange(10, 5)).toBe("10,5");
    expect(formatUnifiedRange(1, 0)).toBe("1,0");
  });
});

describe("buildCreateFilePatch", () => {
  it("produces a new-file diff with trailing newline preserved", () => {
    const patch = buildCreateFilePatch("src/foo.ts", "line1\nline2\n");
    expect(patch).toBe(
      [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/foo.ts",
        "@@ -0,0 +1,2 @@",
        "+line1",
        "+line2",
        "",
      ].join("\n"),
    );
  });

  it("adds 'No newline at end of file' marker when trailing newline missing", () => {
    const patch = buildCreateFilePatch("f.txt", "only");
    expect(patch).toContain("+only\n\\ No newline at end of file\n");
  });

  it("uses single-line range format for one-line files", () => {
    const patch = buildCreateFilePatch("f.txt", "only\n");
    expect(patch).toContain("@@ -0,0 +1 @@\n");
  });

  it("throws when content has zero lines", () => {
    expect(() => buildCreateFilePatch("f.txt", "")).toThrow(
      /content 至少包含一行/,
    );
  });
});
