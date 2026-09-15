import { GRID } from "@blockshop/schema";
import type { Face, MeshBox } from "./types.js";

export const GEOMETRY_FORMAT_VERSION = "1.16.0";
export const TEXTURE_SIZE = 16;

export interface Cube {
  origin: [number, number, number];
  size: [number, number, number];
  uv: Partial<Record<Face, { uv: [number, number]; uv_size: [number, number]; material_instance: string }>>;
}

export function geometryId(namespace: string, id: string): string {
  return `geometry.${namespace}.${id}`;
}

const MIRROR: Record<Face, Face> = { east: "west", west: "east", up: "up", down: "down", north: "north", south: "south" };

/** Editor box → Bedrock block-model cube. Model x/z run -8..8, y runs 0..16. */
export function toCube(b: MeshBox, mirrorX: boolean): Cube {
  const half = GRID / 2;
  const ox = mirrorX ? half - b.x - b.sx : b.x - half;
  const cube: Cube = { origin: [ox, b.y, b.z - half], size: [b.sx, b.sy, b.sz], uv: {} };
  for (const f of b.faces) {
    const face = mirrorX ? MIRROR[f] : f;
    const dims: [number, number] =
      face === "up" || face === "down" ? [b.sx, b.sz] : face === "east" || face === "west" ? [b.sz, b.sy] : [b.sx, b.sy];
    cube.uv[face] = { uv: [0, 0], uv_size: dims, material_instance: b.c };
  }
  return cube;
}

export function cubeBounds(cubes: readonly Cube[]): [number, number, number, number, number, number] {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const c of cubes) {
    minX = Math.min(minX, c.origin[0]); minY = Math.min(minY, c.origin[1]); minZ = Math.min(minZ, c.origin[2]);
    maxX = Math.max(maxX, c.origin[0] + c.size[0]); maxY = Math.max(maxY, c.origin[1] + c.size[1]); maxZ = Math.max(maxZ, c.origin[2] + c.size[2]);
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

export function buildGeometry(namespace: string, id: string, cubes: readonly Cube[]) {
  return {
    format_version: GEOMETRY_FORMAT_VERSION,
    "minecraft:geometry": [
      {
        description: {
          identifier: geometryId(namespace, id),
          texture_width: TEXTURE_SIZE,
          texture_height: TEXTURE_SIZE,
          visible_bounds_width: 2,
          visible_bounds_height: 2,
          visible_bounds_offset: [0, 1, 0],
        },
        bones: [{ name: "root", pivot: [0, 0, 0], cubes }],
      },
    ],
  };
}
