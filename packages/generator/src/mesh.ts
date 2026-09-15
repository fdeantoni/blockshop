import { GRID, type PaletteEntry, type Voxel } from "@blockshop/schema";
import { FACES, type Face, type MeshBox } from "./types.js";

/** Unit direction for each face, Minecraft convention: north = -z, east = +x, up = +y. */
export const FACE_DIR: Record<Face, [number, number, number]> = {
  up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
};

type Grid = (string | undefined)[];
const idx = (x: number, y: number, z: number) => (y * GRID + z) * GRID + x;
const inside = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < GRID && y < GRID && z < GRID;

export function toGrid(voxels: readonly Voxel[]): Grid {
  const g: Grid = new Array(GRID * GRID * GRID).fill(undefined);
  for (const v of voxels) g[idx(v.x, v.y, v.z)] = v.c;
  return g;
}

/**
 * Greedy merge: for each unvisited voxel extend along x, then z, then y while the
 * whole run/row/slab has the same palette id. Deterministic (y, z, x order).
 */
export function mergeBoxes(grid: Grid, merge = true): Omit<MeshBox, "faces">[] {
  const visited = new Uint8Array(GRID * GRID * GRID);
  const boxes: Omit<MeshBox, "faces">[] = [];
  const same = (x: number, y: number, z: number, c: string) => grid[idx(x, y, z)] === c && visited[idx(x, y, z)] === 0;
  for (let y = 0; y < GRID; y++) for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const c = grid[idx(x, y, z)];
    if (c === undefined || visited[idx(x, y, z)]) continue;
    let sx = 1, sz = 1, sy = 1;
    if (merge) {
      while (x + sx < GRID && same(x + sx, y, z, c)) sx++;
      outerZ: while (z + sz < GRID) {
        for (let i = 0; i < sx; i++) if (!same(x + i, y, z + sz, c)) break outerZ;
        sz++;
      }
      outerY: while (y + sy < GRID) {
        for (let j = 0; j < sz; j++) for (let i = 0; i < sx; i++) if (!same(x + i, y + sy, z + j, c)) break outerY;
        sy++;
      }
    }
    for (let dy = 0; dy < sy; dy++) for (let dz = 0; dz < sz; dz++) for (let dx = 0; dx < sx; dx++) visited[idx(x + dx, y + dy, z + dz)] = 1;
    boxes.push({ x, y, z, sx, sy, sz, c });
  }
  return boxes;
}

/**
 * A voxel face is visible when the neighbour is empty, or when the neighbour is
 * translucent and either this voxel is opaque or a different translucent colour.
 * A translucent voxel behind an opaque one is not visible.
 */
export function faceVisible(grid: Grid, translucent: ReadonlySet<string>, x: number, y: number, z: number, face: Face): boolean {
  const c = grid[idx(x, y, z)];
  if (c === undefined) return false;
  const [dx, dy, dz] = FACE_DIR[face];
  const nx = x + dx, ny = y + dy, nz = z + dz;
  if (!inside(nx, ny, nz)) return true;
  const n = grid[idx(nx, ny, nz)];
  if (n === undefined) return true;
  if (!translucent.has(n)) return false;
  return !translucent.has(c) || n !== c;
}

/** Faces of a box that have at least one visible voxel face. */
export function boxFaces(grid: Grid, translucent: ReadonlySet<string>, b: Omit<MeshBox, "faces">): Face[] {
  const faces: Face[] = [];
  for (const face of FACES) {
    let visible = false;
    const [dx, dy, dz] = FACE_DIR[face];
    // Voxels on the box's side in that direction.
    const xs = dx === 1 ? [b.x + b.sx - 1] : dx === -1 ? [b.x] : range(b.x, b.sx);
    const ys = dy === 1 ? [b.y + b.sy - 1] : dy === -1 ? [b.y] : range(b.y, b.sy);
    const zs = dz === 1 ? [b.z + b.sz - 1] : dz === -1 ? [b.z] : range(b.z, b.sz);
    scan: for (const y of ys) for (const z of zs) for (const x of xs) {
      if (faceVisible(grid, translucent, x, y, z, face)) { visible = true; break scan; }
    }
    if (visible) faces.push(face);
  }
  return faces;
}

const range = (start: number, n: number) => Array.from({ length: n }, (_, i) => start + i);

export function translucentIds(palette: readonly PaletteEntry[]): Set<string> {
  return new Set(palette.filter((p) => p.translucent).map((p) => p.id));
}

/** Voxels → merged boxes with culled faces. Boxes with no visible face are dropped. */
export function buildMesh(voxels: readonly Voxel[], palette: readonly PaletteEntry[], merge = true): MeshBox[] {
  const grid = toGrid(voxels);
  const translucent = translucentIds(palette);
  const out: MeshBox[] = [];
  for (const b of mergeBoxes(grid, merge)) {
    const faces = boxFaces(grid, translucent, b);
    if (faces.length > 0) out.push({ ...b, faces });
  }
  return out;
}
