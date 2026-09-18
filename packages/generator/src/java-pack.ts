import {
  PieceSchema, ProjectSchema, sanitizeDisplayName, serverStateKey, unknownPaletteIds,
  type JavaStates, type PaletteEntry, type Piece, type PieceJavaStates, type Project, type Version,
} from "@blockshop/schema";
import { blockIdentifier, buildStableMaterialInstances, paletteUsage, renderMethodFor, textureName } from "./block.js";
import { buildCraftEngineConfig, buildPackYml, CATALOG_ID, CRAFTENGINE_CONFIG_FILE, SHARED_NAMESPACE, type CraftEngineEntry } from "./craftengine.js";
import { buildGeometry, toCube } from "./geometry.js";
import {
  buildCatalogJson, buildGeyserBlockMappings, buildGeyserItemMappings, buildGeyserManifest, buildItemTexture,
  GEYSER_BLOCKS_FILE, GEYSER_ITEMS_FILE, itemIconName, type GeyserEntry,
} from "./geyser.js";
import { buildJavaModel } from "./java-model.js";
import { carrierStateCount } from "./java-states.js";
import { buildMesh } from "./mesh.js";
import { CUBE_MAX, CUBE_WARN, jsonText } from "./pack.js";
import { packIconPng, solidPng } from "./png.js";
import { buildTerrainTexture } from "./resources.js";
import type { FileTree } from "./types.js";
import { zipSubtree } from "./zip.js";

/** Top-level folders of the family-server export tree. */
export const JAVA_DIRS = {
  /** Copied to plugins/CraftEngine/resources/blockshop/ (one pack, every profile's namespace inside) */
  craftengine: "craftengine",
  /** custom_mappings/*.json, copied into Geyser's plugin folder; packs/ holds the zipped served packs */
  geyser: "geyser",
  /** Unzipped Bedrock resource packs, one folder per profile namespace; zipped to geyser/packs/blockshop_<ns>.mcpack */
  geyserRp: "geyser_rp",
  /** pieces.json for the BlockshopCatalog plugin (copied to plugins/BlockshopCatalog/) */
  catalog: "catalog",
} as const;
export const CATALOG_JSON = "pieces.json";

export interface ServerProfileInput {
  project: Project;
  pieces: readonly Piece[];
  /** The profile's icon as a PNG (the editor renders it), for the pack Bedrock players see on joining. */
  packIcon?: Uint8Array | undefined;
  /** Piece id → PNG bytes; used as the Bedrock item icon. Pieces without one get a generated icon. */
  thumbnails?: ReadonlyMap<string, Uint8Array> | undefined;
}

/** Everything the merged export is built from: the export counter, the shared state table, every profile's last published pieces. */
export interface ServerBuildInput {
  version: Version;
  states: JavaStates;
  profiles: readonly ServerProfileInput[];
}

export interface JavaPieceReport {
  id: string;
  javaId: string;
  states: PieceJavaStates;
  elements: number;
  facesEmitted: number;
  renderMethod: "opaque" | "blend";
  seat: boolean;
  hidden: boolean;
  icon: "thumbnail" | "generated";
  warnings: string[];
}

export interface JavaProfileReport {
  namespace: string;
  packName: string;
  pieces: JavaPieceReport[];
}

export interface JavaBuildReport {
  version: Version;
  profiles: JavaProfileReport[];
  warnings: string[];
  fileCount: number;
  carrier: string;
  /** Carrier states still unassigned (four are used per piece). */
  statesLeft: number;
}

export interface JavaBuildResult { tree: FileTree; report: JavaBuildReport }

/**
 * Pure: every profile's pack and pieces → one CraftEngine pack, one set of Geyser mappings and one served
 * Bedrock pack per profile. Every piece must already have Java states in `input.states` (see
 * `allocateServerStates`); throws otherwise, like `buildPack` throws on bad input. No timestamps or randomness.
 */
export function buildServerPack(input: ServerBuildInput): JavaBuildResult {
  const tree: FileTree = new Map();
  const warnings: string[] = [];
  const profileReports: JavaProfileReport[] = [];
  const ceProfiles: Array<{ project: Project; entries: CraftEngineEntry[] }> = [];
  const gyProfiles: Array<{ project: Project; entries: GeyserEntry[] }> = [];
  const { craftengine, geyser, geyserRp } = JAVA_DIRS;
  const namespaces = new Set<string>();
  let pieceCount = 0;

  const profiles = input.profiles.map((p) => ({
    project: ProjectSchema.parse(p.project),
    pieces: p.pieces.map((x) => PieceSchema.parse(x)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    thumbnails: p.thumbnails,
    packIcon: p.packIcon,
  })).sort((a, b) => (a.project.namespace < b.project.namespace ? -1 : a.project.namespace > b.project.namespace ? 1 : 0));

  for (const { project, pieces } of profiles) {
    const ns = project.namespace;
    if (ns === SHARED_NAMESPACE) throw new Error(`namespace ${ns} is reserved`);
    if (namespaces.has(ns)) throw new Error(`duplicate namespace: ${ns}`);
    namespaces.add(ns);
    const seen = new Set<string>();
    for (const piece of pieces) {
      if (seen.has(piece.id)) throw new Error(`${ns}: duplicate piece id: ${piece.id}`);
      seen.add(piece.id);
      if (piece.voxels.length === 0) throw new Error(`${ns}:${piece.id} has no voxels`);
      const unknown = unknownPaletteIds(piece, project.palette);
      if (unknown.length) throw new Error(`${ns}:${piece.id} uses unknown palette ids: ${unknown.join(", ")}`);
      if (!input.states.states[serverStateKey(ns, piece.id)]) throw new Error(`${ns}:${piece.id} has no Java block states yet (allocateServerStates)`);
    }
  }

  const accent0 = profiles[0]?.project.palette[0]?.rgba ?? [184, 148, 95, 255];
  const catalogIcon = packIconPng(32, [accent0[0], accent0[1], accent0[2], 255], [40, 30, 20, 255]);
  const catalogIconName = itemIconName(SHARED_NAMESPACE, CATALOG_ID);

  for (const { project, pieces, thumbnails, packIcon } of profiles) {
    const ns = project.namespace;
    const palette = new Map<string, PaletteEntry>(project.palette.map((p) => [p.id, p]));
    const assets = `${craftengine}/resourcepack/assets/${ns}`;
    const rp = `${geyserRp}/${ns}`;
    const ce: CraftEngineEntry[] = [];
    const gy: GeyserEntry[] = [];
    const reports: JavaPieceReport[] = [];

    for (const piece of pieces) {
      const states = input.states.states[serverStateKey(ns, piece.id)]!;
      const usage = paletteUsage(piece);
      const dominant = usage[0]?.[0] ?? project.palette[0]!.id;
      const renderMethod = renderMethodFor(usage, palette);
      const mesh = buildMesh(piece.voxels, project.palette, project.generator.merge);
      const cubes = mesh.map((b) => toCube(b, project.generator.mirrorX));
      const displayName = sanitizeDisplayName(piece.name, piece.id);
      const pieceWarnings: string[] = [];
      if (mesh.length > CUBE_MAX) pieceWarnings.push(`${mesh.length} elements after merge exceeds the hard limit of ${CUBE_MAX}`);
      else if (mesh.length > CUBE_WARN) pieceWarnings.push(`${mesh.length} elements after merge (heavy; above ${CUBE_WARN})`);

      tree.set(`${assets}/models/block/${piece.id}.json`, jsonText(buildJavaModel(ns, mesh, usage, dominant)));
      tree.set(`${rp}/models/blocks/${ns}_${piece.id}.geo.json`, jsonText(buildGeometry(ns, piece.id, cubes)));
      const thumb = thumbnails?.get(piece.id);
      tree.set(`${rp}/textures/items/${itemIconName(ns, piece.id)}.png`, thumb ?? solidPng(16, palette.get(dominant)?.rgba ?? [128, 128, 128, 255]));

      ce.push({ project, piece, states, sound: palette.get(dominant)?.sound ?? "wood" });
      gy.push({ project, piece, states, displayName, materialInstances: buildStableMaterialInstances(ns, project.palette, renderMethod) });
      reports.push({
        id: piece.id,
        javaId: blockIdentifier(project, piece.id),
        states,
        elements: mesh.length,
        facesEmitted: mesh.reduce((n, b) => n + b.faces.length, 0),
        renderMethod,
        seat: piece.options.seat?.enabled === true,
        hidden: piece.options.hidden === true,
        icon: thumb ? "thumbnail" : "generated",
        warnings: pieceWarnings,
      });
      for (const w of pieceWarnings) warnings.push(`${ns}:${piece.id}: ${w}`);
    }
    pieceCount += pieces.length;

    // CraftEngine textures for this namespace.
    for (const p of project.palette) tree.set(`${assets}/textures/block/${textureName(ns, p.id)}.png`, solidPng(16, p.rgba));

    // The served Bedrock pack for this profile: geometry, palette textures, item icons, plus the shared catalog icon
    // (packs stack on the client, so every pack may carry it). No entities, no scripts.
    const accent = project.palette[0]!.rgba;
    tree.set(`${rp}/manifest.json`, jsonText(buildGeyserManifest(project, pieces.length, input.version)));
    tree.set(`${rp}/pack_icon.png`, packIcon ?? packIconPng(256, [accent[0], accent[1], accent[2], 255], [40, 30, 20, 255]));
    tree.set(`${rp}/textures/terrain_texture.json`, jsonText(buildTerrainTexture(project)));
    tree.set(`${rp}/textures/item_texture.json`, jsonText(buildItemTexture(project.packName, [...pieces.map((p) => itemIconName(ns, p.id)), catalogIconName])));
    tree.set(`${rp}/textures/items/${catalogIconName}.png`, catalogIcon);
    for (const p of project.palette) tree.set(`${rp}/textures/blocks/${textureName(ns, p.id)}.png`, solidPng(16, p.rgba));

    ceProfiles.push({ project, entries: ce });
    gyProfiles.push({ project, entries: gy });
    profileReports.push({ namespace: ns, packName: project.packName, pieces: reports });
  }

  // CraftEngine pack: one config for every namespace, the shared catalog item and its icon.
  tree.set(`${craftengine}/pack.yml`, buildPackYml(input.version, pieceCount));
  tree.set(`${craftengine}/${CRAFTENGINE_CONFIG_FILE}`, jsonText(buildCraftEngineConfig(ceProfiles)));
  tree.set(`${craftengine}/resourcepack/assets/${SHARED_NAMESPACE}/textures/item/${CATALOG_ID}.png`, catalogIcon);

  // Catalog plugin input, Geyser mappings.
  const allGy = gyProfiles.flatMap((p) => p.entries);
  tree.set(`${JAVA_DIRS.catalog}/${CATALOG_JSON}`, jsonText(buildCatalogJson(input.version, gyProfiles)));
  tree.set(`${geyser}/${GEYSER_BLOCKS_FILE}`, jsonText(buildGeyserBlockMappings(allGy)));
  tree.set(`${geyser}/${GEYSER_ITEMS_FILE}`, jsonText(buildGeyserItemMappings(allGy)));

  const report: JavaBuildReport = {
    version: input.version,
    profiles: profileReports,
    warnings,
    fileCount: tree.size,
    carrier: input.states.carrier,
    statesLeft: carrierStateCount(input.states.carrier) - input.states.cursor,
  };
  return { tree: new Map([...tree.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), report };
}

/** Namespaces that have a served pack in the tree. */
export function geyserPackNamespaces(tree: FileTree): string[] {
  const out = new Set<string>();
  const prefix = `${JAVA_DIRS.geyserRp}/`;
  for (const k of tree.keys()) if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split("/")[0]!);
  return [...out].sort();
}

/** The `.mcpack` for Geyser's packs folder: one profile's served pack zipped with its files at the root. */
export function geyserMcpack(tree: FileTree, namespace: string): Uint8Array {
  return zipSubtree(tree, `${JAVA_DIRS.geyserRp}/${namespace}/`);
}
