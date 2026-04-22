import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asString,
  countOccurrences,
  normalizeOptionalPositiveInt,
  normalizeRelativePath,
  stripLineNumberPrefixes,
} from "./toolArgParsing";

describe("normalizeRelativePath", () => {
  it("trims string values", () => {
    expect(normalizeRelativePath("  src/foo.ts  ")).toBe("src/foo.ts");
  });

  it("returns empty string for non-string inputs", () => {
    expect(normalizeRelativePath(undefined)).toBe("");
    expect(normalizeRelativePath(null)).toBe("");
    expect(normalizeRelativePath(42)).toBe("");
    expect(normalizeRelativePath({})).toBe("");
  });
});

describe("asString", () => {
  it("returns the value when it is a string", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("")).toBe("");
  });

  it("returns the fallback for non-string inputs", () => {
    expect(asString(undefined, "default")).toBe("default");
    expect(asString(null, "default")).toBe("default");
    expect(asString(123, "default")).toBe("default");
  });

  it("defaults fallback to empty string", () => {
    expect(asString(null)).toBe("");
  });
});

describe("stripLineNumberPrefixes", () => {
  it("removes '<number>│' prefixes on every line", () => {
    const input = "10│const a = 1;\n11│const b = 2;";
    expect(stripLineNumberPrefixes(input)).toBe("const a = 1;\nconst b = 2;");
  });

  it("tolerates leading whitespace before the number", () => {
    const input = "  10│foo\n 100│bar";
    expect(stripLineNumberPrefixes(input)).toBe("foo\nbar");
  });

  it("normalizes CRLF and CR to LF", () => {
    expect(stripLineNumberPrefixes("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("leaves lines without the prefix untouched", () => {
    expect(stripLineNumberPrefixes("no prefix here")).toBe("no prefix here");
  });
});

describe("asNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(asNumber(42, 0)).toBe(42);
    expect(asNumber(0, 99)).toBe(0);
    expect(asNumber(-1.5, 0)).toBe(-1.5);
  });

  it("falls back for non-numeric inputs", () => {
    expect(asNumber("42", 7)).toBe(7);
    expect(asNumber(null, 7)).toBe(7);
    expect(asNumber(undefined, 7)).toBe(7);
  });

  it("falls back for NaN and infinities", () => {
    expect(asNumber(Number.NaN, 7)).toBe(7);
    expect(asNumber(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(asNumber(Number.NEGATIVE_INFINITY, 7)).toBe(7);
  });
});

describe("asBoolean", () => {
  it("returns booleans as-is", () => {
    expect(asBoolean(true, false)).toBe(true);
    expect(asBoolean(false, true)).toBe(false);
  });

  it("falls back for non-boolean inputs", () => {
    expect(asBoolean("true", false)).toBe(false);
    expect(asBoolean(1, false)).toBe(false);
    expect(asBoolean(undefined, true)).toBe(true);
  });
});

describe("normalizeOptionalPositiveInt", () => {
  it("returns floored positive ints", () => {
    expect(normalizeOptionalPositiveInt(5)).toBe(5);
    expect(normalizeOptionalPositiveInt(5.9)).toBe(5);
  });

  it("returns null for zero and negatives", () => {
    expect(normalizeOptionalPositiveInt(0)).toBeNull();
    expect(normalizeOptionalPositiveInt(-1)).toBeNull();
  });

  it("returns null for non-finite and non-number values", () => {
    expect(normalizeOptionalPositiveInt(Number.NaN)).toBeNull();
    expect(normalizeOptionalPositiveInt(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeOptionalPositiveInt("5")).toBeNull();
    expect(normalizeOptionalPositiveInt(undefined)).toBeNull();
    expect(normalizeOptionalPositiveInt(null)).toBeNull();
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("ababab", "ab")).toBe(3);
    expect(countOccurrences("hello world", "o")).toBe(2);
  });

  it("returns 0 for empty snippet", () => {
    expect(countOccurrences("anything", "")).toBe(0);
  });

  it("returns 0 when snippet is not present", () => {
    expect(countOccurrences("abc", "xyz")).toBe(0);
  });

  it("handles single-character repeats without infinite looping", () => {
    expect(countOccurrences("aaaa", "a")).toBe(4);
  });

  it("handles empty haystack", () => {
    expect(countOccurrences("", "x")).toBe(0);
  });
});
