import { describe, expect, it } from "vitest";
import { finitePoints, normalizeDecorativeVariant } from "./DecorativeNode";

describe("DecorativeNode payload safety", () => {
  it("recognizes v2 variants and falls back unknown values", () => {
    expect(normalizeDecorativeVariant("text")).toBe("text");
    expect(normalizeDecorativeVariant("freehand")).toBe("freehand");
    expect(normalizeDecorativeVariant("future_variant")).toBe("unknown");
    expect(normalizeDecorativeVariant(undefined)).toBe("unknown");
  });

  it("keeps only finite point pairs for freehand/drawing payloads", () => {
    expect(finitePoints([
      [1, 2],
      { x: 3, y: 4 },
      [Number.NaN, 8],
      { x: "bad", y: 9 },
    ])).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });
});
