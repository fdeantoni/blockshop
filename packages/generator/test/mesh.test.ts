import { describe, it, expect } from "vitest";
import { GRID, type Voxel } from "@blockshop/schema";
import { FACES, FACE_DIR, buildMesh, faceVisible, mergeBoxes, toGrid, translucentIds } from "../src/index.js";
import { fixtureIds, lcg, piece, project } from "./helpers.js";

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

function randomVoxels(seed: number, n: number, colours: string[]): Voxel[] {
  const rnd = lcg(seed);
  const m = new Map<string, Voxel>();
  while (m.size < n) {
    const x = Math.floor(rnd() * GRID), y = Math.floor(rnd() * GRID), z = Math.floor(rnd() * GRID);
    const c = colours[Math.floor(rnd() * colours.length)]!;
    m.set(key(x, y, z), { x, y, z, c });
  }
  return [...m.values()];
}

function boxCells(b: { x: number; y: number; z: number; sx: number; sy: number; sz: number }): string[] {
  const out: string[] = [];
  for (let y = b.y; y < b.y + b.sy; y++) for (let z = b.z; z < b.z + b.sz; z++) for (let x = b.x; x < b.x + b.sx; x++) out.push(key(x, y, z));
  return out;
}

const cases: Array<[string, Voxel[]]> = [
  ...fixtureIds().map((id): [string, Voxel[]] => [id, piece(id).voxels]),
  ["random-sparse", randomVoxels(1, 200, ["oak", "red"])],
  ["random-dense", randomVoxels(2, 2500, ["oak", "glass", "stone"])],
  ["random-glass", randomVoxels(3, 800, ["glass"])],
];

describe("mergeBoxes covers exactly the voxel set", () => {
  for (const [name, voxels] of cases) for (const merge of [true, false]) {
    it(`${name} merge=${merge}`, () => {
      const boxes = mergeBoxes(toGrid(voxels), merge);
      const covered = new Map<string, string>();
      for (const b of boxes) for (const k of boxCells(b)) {
        expect(covered.has(k), `overlap at ${k}`).toBe(false);
        covered.set(k, b.c);
      }
      expect(covered.size).toBe(voxels.length);
      for (const v of voxels) expect(covered.get(key(v.x, v.y, v.z))).toBe(v.c);
      if (!merge) expect(boxes.length).toBe(voxels.length);
    });
  }
});

describe("face culling", () => {
  const palette = project().palette;
  const translucent = translucentIds(palette);
  for (const [name, voxels] of cases) {
    it(`${name}: every visible voxel face is covered, every emitted face has a visible voxel`, () => {
      const grid = toGrid(voxels);
      const mesh = buildMesh(voxels, palette, true);
      const byCell = new Map<string, (typeof mesh)[number]>();
      for (const b of mesh) for (const k of boxCells(b)) byCell.set(k, b);
      for (const v of voxels) for (const f of FACES) {
        if (!faceVisible(grid, translucent, v.x, v.y, v.z, f)) continue;
        const b = byCell.get(key(v.x, v.y, v.z));
        expect(b, `voxel ${key(v.x, v.y, v.z)} with visible ${f} face has no box`).toBeDefined();
        expect(b!.faces, `box for ${key(v.x, v.y, v.z)} lacks ${f}`).toContain(f);
      }
      for (const b of mesh) for (const f of b.faces) {
        const [dx, dy, dz] = FACE_DIR[f];
        const cells = boxCells(b).filter(([]) => true).map((k) => k.split(",").map(Number) as [number, number, number]);
        const side = cells.filter(([x, y, z]) =>
          (dx === 1 ? x === b.x + b.sx - 1 : dx === -1 ? x === b.x : true) &&
          (dy === 1 ? y === b.y + b.sy - 1 : dy === -1 ? y === b.y : true) &&
          (dz === 1 ? z === b.z + b.sz - 1 : dz === -1 ? z === b.z : true));
        expect(side.some(([x, y, z]) => faceVisible(grid, translucent, x, y, z, f)), `face ${f} of box at ${key(b.x, b.y, b.z)} is fully occluded`).toBe(true);
      }
    });
  }
  it("full cube merges to one box with six faces", () => {
    const mesh = buildMesh(piece("full_cube").voxels, palette);
    expect(mesh).toHaveLength(1);
    expect(mesh[0]!.faces).toHaveLength(6);
    expect(mesh[0]).toMatchObject({ x: 0, y: 0, z: 0, sx: 16, sy: 16, sz: 16 });
  });
  it("interior voxels of an opaque cube have no visible faces", () => {
    const grid = toGrid(piece("full_cube").voxels);
    expect(FACES.some((f) => faceVisible(grid, translucent, 7, 7, 7, f))).toBe(false);
    expect(faceVisible(grid, translucent, 0, 7, 7, "west")).toBe(true);
  });
  it("glass next to same glass is culled, glass next to oak keeps the oak face only", () => {
    const grid = toGrid([{ x: 0, y: 0, z: 0, c: "glass" }, { x: 1, y: 0, z: 0, c: "glass" }, { x: 2, y: 0, z: 0, c: "oak" }]);
    expect(faceVisible(grid, translucent, 0, 0, 0, "east")).toBe(false);
    expect(faceVisible(grid, translucent, 1, 0, 0, "east")).toBe(false); // glass behind oak
    expect(faceVisible(grid, translucent, 2, 0, 0, "west")).toBe(true);  // oak seen through glass
  });
  it("merging reduces the chair to far fewer cubes", () => {
    const voxels = piece("chair_asym").voxels;
    expect(buildMesh(voxels, palette, true).length).toBeLessThan(voxels.length / 4);
  });
});
