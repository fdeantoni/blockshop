import { PieceSchema, ProjectSchema, type PaletteEntry, type Piece, type Project, unknownPaletteIds } from "@blockshop/schema";
import { buildBlock, paletteUsage, textureName } from "./block.js";
import { buildGeometry, toCube, type Cube } from "./geometry.js";
import { buildMesh } from "./mesh.js";
import { packIconPng, solidPng } from "./png.js";
import { buildBlocksJson, buildLang, buildManifests, buildTerrainTexture, packFolderNames } from "./resources.js";
import { buildSeatClientEntity, buildSeatEntity, buildSeatGeometry, buildSeatRenderController, buildSeatScript } from "./seat.js";
import type { BuildReport, BuildResult, FileTree, PieceReport } from "./types.js";

export const CUBE_WARN = 256;
export const CUBE_MAX = 512;

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Pure: Project + pieces → file tree of both packs plus a report.
 * Throws on invalid input (schema errors, unknown palette ids, empty pieces).
 * Output depends only on the input; no timestamps or randomness.
 */
export function buildPack(projectIn: Project, piecesIn: readonly Piece[], opts: { packIcon?: Uint8Array | undefined } = {}): BuildResult {
  const project = ProjectSchema.parse(projectIn);
  const pieces = piecesIn.map((p) => PieceSchema.parse(p)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const palette = new Map<string, PaletteEntry>(project.palette.map((p) => [p.id, p]));
  const { bp, rp } = packFolderNames(project);
  const ns = project.namespace;
  const tree: FileTree = new Map();
  const reports: PieceReport[] = [];
  const warnings: string[] = [];

  const seen = new Set<string>();
  for (const piece of pieces) {
    if (seen.has(piece.id)) throw new Error(`duplicate piece id: ${piece.id}`);
    seen.add(piece.id);
    if (piece.voxels.length === 0) throw new Error(`piece ${piece.id} has no voxels`);
    const unknown = unknownPaletteIds(piece, project.palette);
    if (unknown.length) throw new Error(`piece ${piece.id} uses unknown palette ids: ${unknown.join(", ")}`);
  }

  const soundEntries: Array<{ id: string; sound: PaletteEntry["sound"] & string }> = [];
  for (const piece of pieces) {
    const usage = paletteUsage(piece);
    const mesh = buildMesh(piece.voxels, project.palette, project.generator.merge);
    const cubes: Cube[] = mesh.map((b) => toCube(b, project.generator.mirrorX));
    const block = buildBlock({ project, piece, cubes, usage, palette });
    const pieceWarnings: string[] = [];
    if (cubes.length > CUBE_MAX) pieceWarnings.push(`${cubes.length} cubes after merge exceeds the hard limit of ${CUBE_MAX}`);
    else if (cubes.length > CUBE_WARN) pieceWarnings.push(`${cubes.length} cubes after merge (heavy; above ${CUBE_WARN})`);

    tree.set(`${bp}/blocks/${ns}_${piece.id}.json`, jsonText(block.json));
    tree.set(`${rp}/models/blocks/${ns}_${piece.id}.geo.json`, jsonText(buildGeometry(ns, piece.id, cubes)));
    soundEntries.push({ id: piece.id, sound: block.sound });
    reports.push({
      id: piece.id,
      identifier: block.identifier,
      name: piece.name,
      voxels: piece.voxels.length,
      cubesBeforeMerge: piece.voxels.length,
      cubesAfterMerge: cubes.length,
      facesEmitted: mesh.reduce((n, b) => n + b.faces.length, 0),
      renderMethod: block.renderMethod,
      bounds: block.bounds,
      hidden: block.hidden,
      seat: block.seat,
      warnings: pieceWarnings,
    });
    for (const w of pieceWarnings) warnings.push(`${piece.id}: ${w}`);
  }

  const seatsEnabled = reports.some((r) => r.seat);
  const manifests = buildManifests(project, { scripts: seatsEnabled, pieceCount: pieces.length });
  const lang = buildLang(project, pieces, { seats: seatsEnabled });
  const languages = jsonText(["en_US"]);
  const accent = project.palette[0]!.rgba;
  // The profile's own icon when the editor has drawn one (it can render emoji and the custom icons;
  // nothing here can), else the generated chair glyph.
  const icon = opts.packIcon ?? packIconPng(256, [accent[0], accent[1], accent[2], 255], [40, 30, 20, 255]);

  tree.set(`${bp}/manifest.json`, jsonText(manifests.bp));
  tree.set(`${bp}/texts/en_US.lang`, lang);
  tree.set(`${bp}/texts/languages.json`, languages);
  tree.set(`${bp}/pack_icon.png`, icon);
  tree.set(`${rp}/manifest.json`, jsonText(manifests.rp));
  tree.set(`${rp}/blocks.json`, jsonText(buildBlocksJson(project, soundEntries)));
  tree.set(`${rp}/textures/terrain_texture.json`, jsonText(buildTerrainTexture(project)));
  tree.set(`${rp}/texts/en_US.lang`, lang);
  tree.set(`${rp}/texts/languages.json`, languages);
  tree.set(`${rp}/pack_icon.png`, icon);
  for (const p of project.palette) tree.set(`${rp}/textures/blocks/${textureName(ns, p.id)}.png`, solidPng(16, p.rgba));

  if (seatsEnabled) {
    tree.set(`${bp}/entities/seat.json`, jsonText(buildSeatEntity(project)));
    tree.set(`${bp}/scripts/main.js`, buildSeatScript(project));
    tree.set(`${rp}/entity/seat.entity.json`, jsonText(buildSeatClientEntity(project)));
    tree.set(`${rp}/models/entity/seat.geo.json`, jsonText(buildSeatGeometry(project)));
    tree.set(`${rp}/render_controllers/seat.render_controllers.json`, jsonText(buildSeatRenderController(project)));
    tree.set(`${rp}/textures/entity/${ns}_seat.png`, solidPng(16, [0, 0, 0, 0]));
  }

  const report: BuildReport = {
    version: project.version,
    packName: project.packName,
    seatsEnabled,
    pieces: reports,
    warnings,
    fileCount: tree.size,
  };
  return { tree: sortTree(tree), report };
}

function sortTree(tree: FileTree): FileTree {
  return new Map([...tree.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
