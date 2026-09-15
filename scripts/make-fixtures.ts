/**
 * Regenerates fixtures/pieces/*.json. Run: pnpm fixtures
 * Fixture shapes are described in code so they stay reviewable.
 * Axes: x → east, y → up, z → south (Minecraft world axes).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GRID, type Voxel, sortVoxels } from "../packages/schema/src/index.js";

const out = fileURLToPath(new URL("../fixtures/pieces/", import.meta.url));
mkdirSync(out, { recursive: true });
const T0 = "2026-09-14T00:00:00.000Z";

type Box = { x: [number, number]; y: [number, number]; z: [number, number]; c: string };
function fill(voxels: Map<string, Voxel>, b: Box) {
  for (let y = b.y[0]; y <= b.y[1]; y++) for (let z = b.z[0]; z <= b.z[1]; z++) for (let x = b.x[0]; x <= b.x[1]; x++)
    voxels.set(`${x},${y},${z}`, { x, y, z, c: b.c });
}
function clear(voxels: Map<string, Voxel>, b: Omit<Box, "c">) {
  for (let y = b.y[0]; y <= b.y[1]; y++) for (let z = b.z[0]; z <= b.z[1]; z++) for (let x = b.x[0]; x <= b.x[1]; x++)
    voxels.delete(`${x},${y},${z}`);
}
function piece(id: string, name: string, build: (v: Map<string, Voxel>) => void, options: Record<string, unknown> = {}) {
  const v = new Map<string, Voxel>();
  build(v);
  const json = { id, name, author: "fixture", createdAt: T0, updatedAt: T0, voxels: sortVoxels([...v.values()]), options };
  writeFileSync(out + id + ".json", JSON.stringify(json, null, 2) + "\n");
  console.log(`${id}: ${json.voxels.length} voxels`);
}

// Chair asymmetric on both x and z: back on the north side (low z), armrest on the east side (high x) only.
piece("chair_asym", "Stoel", (v) => {
  for (const [x, z] of [[4, 4], [11, 4], [4, 11], [11, 11]] as const) fill(v, { x: [x, x], y: [0, 3], z: [z, z], c: "dark_wood" });
  fill(v, { x: [4, 11], y: [4, 4], z: [4, 11], c: "oak" });            // seat
  fill(v, { x: [4, 11], y: [5, 11], z: [4, 4], c: "dark_wood" });      // back (north)
  fill(v, { x: [11, 11], y: [5, 7], z: [5, 11], c: "dark_wood" });     // armrest (east only)
  fill(v, { x: [5, 10], y: [5, 5], z: [5, 11], c: "red" });            // cushion stripe
}, { seat: { enabled: true, height: 5 } });

piece("table", "Tafel", (v) => {
  for (const [x, z] of [[2, 2], [13, 2], [2, 13], [13, 13]] as const) fill(v, { x: [x, x], y: [0, 5], z: [z, z], c: "dark_wood" });
  fill(v, { x: [1, 14], y: [6, 6], z: [1, 14], c: "oak" });
});

// Hollow dark-wood cabinet with a glass front on the south face.
piece("glass_cabinet", "Vitrinekast", (v) => {
  fill(v, { x: [3, 12], y: [0, 13], z: [5, 10], c: "dark_wood" });
  clear(v, { x: [4, 11], y: [1, 12], z: [6, 9] });                     // hollow interior
  fill(v, { x: [4, 11], y: [1, 12], z: [10, 10], c: "glass" });        // glass front (south)
  fill(v, { x: [4, 11], y: [6, 6], z: [6, 9], c: "oak" });             // shelf
}, { light: 7 });

piece("single_voxel", "Blokje", (v) => { fill(v, { x: [7, 7], y: [0, 0], z: [7, 7], c: "red" }); });

piece("full_cube", "Steenblok", (v) => { fill(v, { x: [0, GRID - 1], y: [0, GRID - 1], z: [0, GRID - 1], c: "stone" }); });
