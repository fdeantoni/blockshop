import { describe, it, expect } from "vitest";
import { buildGeometry, cubeBounds, toCube, geometryId } from "../src/index.js";
import type { MeshBox } from "../src/index.js";

const box: MeshBox = { x: 7, y: 0, z: 7, sx: 1, sy: 1, sz: 1, c: "red", faces: ["up", "east", "north"] };

describe("toCube", () => {
  it("maps editor space to model space (-8..8 on x/z, 0..16 on y)", () => {
    const c = toCube(box, false);
    expect(c.origin).toEqual([-1, 0, -1]);
    expect(c.size).toEqual([1, 1, 1]);
    expect(Object.keys(c.uv).sort()).toEqual(["east", "north", "up"]);
    expect(c.uv.east).toEqual({ uv: [0, 0], uv_size: [1, 1], material_instance: "red" });
  });
  it("mirrorX flips the x origin and swaps east/west", () => {
    const c = toCube({ ...box, x: 0, sx: 3 }, true);
    expect(c.origin).toEqual([5, 0, -1]);
    expect(Object.keys(c.uv).sort()).toEqual(["north", "up", "west"]);
  });
  it("uses face dimensions for uv_size", () => {
    const c = toCube({ x: 0, y: 0, z: 0, sx: 4, sy: 2, sz: 3, c: "oak", faces: ["up", "north", "east"] }, false);
    expect(c.uv.up!.uv_size).toEqual([4, 3]);
    expect(c.uv.north!.uv_size).toEqual([4, 2]);
    expect(c.uv.east!.uv_size).toEqual([3, 2]);
  });
  it("bounds span all cubes", () => {
    expect(cubeBounds([toCube(box, false), toCube({ ...box, x: 0, y: 3, z: 0 }, false)])).toEqual([-8, 0, -8, 0, 4, 0]);
  });
  it("geometry file carries identifier and 16×16 texture size", () => {
    const g = buildGeometry("family", "chair_1", [toCube(box, false)]);
    expect(g["minecraft:geometry"][0]!.description.identifier).toBe(geometryId("family", "chair_1"));
    expect(g["minecraft:geometry"][0]!.description.texture_width).toBe(16);
    expect(g["minecraft:geometry"][0]!.bones[0]!.cubes).toHaveLength(1);
  });
});
