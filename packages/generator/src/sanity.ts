import { GRID, ID_RE, type Piece, type Project, unknownPaletteIds } from "@blockshop/schema";
import { packFolderNames } from "./resources.js";
import { CUBE_MAX, CUBE_WARN } from "./pack.js";
import type { BuildResult } from "./types.js";

export interface SanityResult { errors: string[]; warnings: string[] }

/** Own checks on input and output; cheap enough to run in CI and on every publish. */
export function sanityCheck(project: Project, pieces: readonly Piece[], result: BuildResult): SanityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { bp, rp } = packFolderNames(project);
  const ns = project.namespace;

  const ids = new Set<string>();
  for (const p of pieces) {
    const lower = p.id.toLowerCase();
    if (ids.has(lower)) errors.push(`duplicate piece id (case-insensitive): ${p.id}`);
    ids.add(lower);
    if (!ID_RE.test(p.id)) errors.push(`invalid piece id: ${p.id}`);
    if (p.voxels.length === 0) errors.push(`${p.id}: no voxels`);
    const unknown = unknownPaletteIds(p, project.palette);
    if (unknown.length) errors.push(`${p.id}: unknown palette ids ${unknown.join(", ")}`);
  }
  const paletteIds = new Set<string>();
  for (const e of project.palette) {
    if (paletteIds.has(e.id)) errors.push(`duplicate palette id: ${e.id}`);
    paletteIds.add(e.id);
  }
  const uuids = Object.values(project.uuids);
  if (new Set(uuids).size !== uuids.length) errors.push("pack uuids are not distinct");

  const text = (path: string): string | undefined => {
    const v = result.tree.get(path);
    return typeof v === "string" ? v : undefined;
  };
  const lang = text(`${bp}/texts/en_US.lang`) ?? "";
  for (const r of result.report.pieces) {
    const blockPath = `${bp}/blocks/${ns}_${r.id}.json`;
    const geoPath = `${rp}/models/blocks/${ns}_${r.id}.geo.json`;
    const block = text(blockPath);
    const geo = text(geoPath);
    if (!block) { errors.push(`${r.id}: missing ${blockPath}`); continue; }
    if (!geo) { errors.push(`${r.id}: missing ${geoPath}`); continue; }
    const geoId = JSON.parse(block)["minecraft:block"].components["minecraft:geometry"].identifier as string;
    const defined = JSON.parse(geo)["minecraft:geometry"][0].description.identifier as string;
    if (geoId !== defined) errors.push(`${r.id}: block references ${geoId} but geometry defines ${defined}`);
    if (!lang.includes(`tile.${r.identifier}.name=`)) errors.push(`${r.id}: no display name in en_US.lang`);
    if (r.cubesAfterMerge > CUBE_MAX) errors.push(`${r.id}: ${r.cubesAfterMerge} cubes exceeds ${CUBE_MAX}`);
    else if (r.cubesAfterMerge > CUBE_WARN) warnings.push(`${r.id}: ${r.cubesAfterMerge} cubes (above ${CUBE_WARN})`);
    const [minX, minY, minZ, maxX, maxY, maxZ] = r.bounds;
    const half = GRID / 2;
    if (minX < -half || minZ < -half || minY < 0 || maxX > half || maxZ > half || maxY > GRID)
      errors.push(`${r.id}: bounds ${r.bounds.join(",")} leave the block volume`);
  }
  for (const w of result.report.warnings) if (!warnings.includes(w)) warnings.push(w);
  return { errors, warnings };
}
