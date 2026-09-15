import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, GRID } from "@blockshop/schema";
import { TEMPLATES, box, cut, shape } from "../src/templates.js";

describe("templates", () => {
  const ids = new Set(DEFAULT_PALETTE.map((p) => p.id));

  it("ship a dozen starting points with unique ids", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  for (const t of TEMPLATES) {
    it(`${t.id}: fits the grid, uses palette colours, no duplicate cells`, () => {
      expect(t.voxels.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const v of t.voxels) {
        for (const k of [v.x, v.y, v.z]) { expect(k).toBeGreaterThanOrEqual(0); expect(k).toBeLessThan(GRID); }
        expect(ids.has(v.c), `${t.id} uses unknown colour ${v.c}`).toBe(true);
        const key = `${v.x},${v.y},${v.z}`;
        expect(seen.has(key), `${t.id} has ${key} twice`).toBe(false);
        seen.add(key);
      }
      // Every template stands on the floor so it sits on the block below.
      expect(Math.min(...t.voxels.map((v) => v.y))).toBe(0);
      if (t.options.seat) {
        expect(t.options.seat.enabled).toBe(true);
        expect(t.options.seat.height).toBeGreaterThanOrEqual(0);
        expect(t.options.seat.height).toBeLessThan(GRID);
      }
      if (t.options.light !== undefined) expect([0, 7, 15]).toContain(t.options.light);
      expect(t.options.hidden).toBeUndefined();
    });
  }

  it("box, shape and cut build inclusive volumes, last part wins", () => {
    expect(box(0, 0, 0, 1, 1, 1, "red")).toHaveLength(8);
    const s = shape(box(0, 0, 0, 1, 0, 0, "red"), box(1, 0, 0, 2, 0, 0, "blue"));
    expect(s).toHaveLength(3);
    expect(s.find((v) => v.x === 1)?.c).toBe("blue");
    expect(cut(box(0, 0, 0, 2, 0, 0, "red"), 1, 0, 0, 1, 0, 0).map((v) => v.x)).toEqual([0, 2]);
  });
});
