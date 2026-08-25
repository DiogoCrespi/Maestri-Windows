import { describe, expect, it } from "vitest";
import { catmullRomPathSvg, finitePoints, normalizeDecorativeVariant, relativeToSvgPoints } from "./DecorativeNode";

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

  it("scales normalized points relative to width/height and preserves absolute coordinates", () => {
    const normalized = [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }];
    expect(relativeToSvgPoints(normalized, 200, 100)).toEqual([{ x: 20, y: 20 }, { x: 160, y: 90 }]);

    const absolute = [{ x: 10, y: 20 }, { x: 100, y: 80 }];
    expect(relativeToSvgPoints(absolute, 200, 100)).toEqual([{ x: 10, y: 20 }, { x: 100, y: 80 }]);
  });

  it("generates Catmull-Rom SVG path string for freehand stroke smooth rendering", () => {
    const pts = [{ x: 10, y: 10 }, { x: 50, y: 20 }, { x: 90, y: 60 }];
    const path = catmullRomPathSvg(pts);
    expect(path).toContain("M 10.00 10.00");
    expect(path).toContain("C ");
    expect(catmullRomPathSvg([])).toBe("");
    expect(catmullRomPathSvg([{ x: 5, y: 5 }, { x: 15, y: 25 }])).toBe("M 5.00 5.00 L 15.00 25.00");
  });
});
