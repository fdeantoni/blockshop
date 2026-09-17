import { describe, it, expect } from "vitest";
import { GRID } from "@blockshop/schema";
import { buildGeometry, buildMesh, cubeBounds, toCube, geometryId } from "../src/index.js";
import type { Face, MeshBox } from "../src/index.js";
import { lcg, piece, project } from "./helpers.js";

const box: MeshBox = { x: 7, y: 0, z: 7, sx: 1, sy: 1, sz: 1, c: "red", faces: ["up", "east", "north"] };

describe("toCube", () => {
  it("maps editor space to model space (-8..8 on x/z, 0..16 on y)", () => {
    const c = toCube(box, false);
    expect(c.origin).toEqual([-1, 0, -1]);
    expect(c.size).toEqual([1, 1, 1]);
    expect(Object.keys(c.uv).sort()).toEqual(["north", "up", "west"]);
    expect(c.uv.west).toEqual({ uv: [0, 0], uv_size: [1, 1], material_instance: "red" });
  });
  it("without mirrorX the piece is mirrored, so east/west faces swap", () => {
    expect(Object.keys(toCube(box, false).uv).sort()).toEqual(["north", "up", "west"]);
    expect(Object.keys(toCube({ ...box, faces: ["west"] }, false).uv)).toEqual(["east"]);
  });
  it("mirrorX flips the x origin and keeps the face keys (they name world sides)", () => {
    const c = toCube({ ...box, x: 0, sx: 3 }, true);
    expect(c.origin).toEqual([5, 0, -1]);
    expect(Object.keys(c.uv).sort()).toEqual(["east", "north", "up"]);
  });
  it("mirrorX: a box whose east side touches another box draws only its west side", () => {
    // Editor: red at x=0, blue at x=1. Red's west side (world -x, file +x) is the exposed one.
    const mesh = buildMesh([{ x: 0, y: 0, z: 0, c: "red" }, { x: 1, y: 0, z: 0, c: "blue" }], project().palette);
    const [red, blue] = mesh.map((b) => toCube(b, true));
    expect(red!.origin[0]).toBe(7);
    expect(blue!.origin[0]).toBe(6);
    expect(red!.uv.west).toBeDefined();
    expect(red!.uv.east).toBeUndefined();
    expect(blue!.uv.east).toBeDefined();
    expect(blue!.uv.west).toBeUndefined();
  });
  it("mirrorX: every exposed voxel face is drawn on the side its key names", () => {
    // Read the file as Blockbench and the game do: world x = -file x, keys are world sides.
    const dirs: Record<Face, [number, number, number]> = {
      east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1],
    };
    const pr = project();
    const rnd = lcg(7);
    const colours = ["red", "oak", "blue"];
    const random = Array.from({ length: 400 }, () => ({
      x: Math.floor(rnd() * GRID), y: Math.floor(rnd() * GRID), z: Math.floor(rnd() * GRID), c: colours[Math.floor(rnd() * 3)]!,
    }));
    for (const voxels of [piece("chair_asym").voxels, random]) {
      const occupied = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
      const cubes = buildMesh(voxels, pr.palette).map((b) => toCube(b, true));
      for (const c of cubes) {
        // Back to editor coordinates: the file spans x 8 - x0 - sx .. 8 - x0.
        const x0 = -(c.origin[0] + c.size[0]) + GRID / 2, y0 = c.origin[1], z0 = c.origin[2] + GRID / 2;
        for (const [face, [dx, dy, dz]] of Object.entries(dirs) as [Face, [number, number, number]][]) {
          let exposed = false;
          for (let x = x0; x < x0 + c.size[0]; x++) for (let y = y0; y < y0 + c.size[1]; y++) for (let z = z0; z < z0 + c.size[2]; z++) {
            const inside = x + dx >= x0 && x + dx < x0 + c.size[0] && y + dy >= y0 && y + dy < y0 + c.size[1] && z + dz >= z0 && z + dz < z0 + c.size[2];
            if (!inside && !occupied.has(`${x + dx},${y + dy},${z + dz}`)) exposed = true;
          }
          expect(face in c.uv, `${face} of cube at ${c.origin}`).toBe(exposed);
        }
      }
    }
  });
  it("uses face dimensions for uv_size", () => {
    const c = toCube({ x: 0, y: 0, z: 0, sx: 4, sy: 2, sz: 3, c: "oak", faces: ["up", "north", "east"] }, true);
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
