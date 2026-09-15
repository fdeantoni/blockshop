import { FACINGS, sanitizeDisplayName, type Piece, type PieceJavaStates, type Project, type Version } from "@blockshop/schema";
import { blockIdentifier, type RenderMethod } from "./block.js";
import { CATALOG_ID, CATALOG_NAME, SHARED_NAMESPACE, catalogItemId } from "./craftengine.js";
import { geometryId } from "./geometry.js";
import { javaBlockOf, stateKey } from "./java-states.js";
import { deriveUuid } from "./uuid.js";

/** Prefix of the Bedrock block names (`geyser_custom:blockshop_<carrier block>`), one per vanilla carrier block. */
export const GEYSER_BLOCK_NAME = "blockshop";
export const GEYSER_BLOCKS_FILE = "custom_mappings/blockshop_blocks.json";
export const GEYSER_ITEMS_FILE = "custom_mappings/blockshop_items.json";
/** Every file Blockshop may have put in Geyser's packs folder, current and earlier layouts. */
export const GEYSER_MCPACK_RE = /^blockshop([_-][a-z0-9_.-]*)?\.mcpack$/;

/** One served pack per profile: `blockshop_<namespace>.mcpack`. Constant names; clients re-download on the version bump. */
export function geyserMcpackName(namespace: string): string {
  return `blockshop_${namespace}.mcpack`;
}

export interface GeyserEntry {
  project: Project;
  piece: Piece;
  states: PieceJavaStates;
  displayName: string;
  /** Full palette (see `buildStableMaterialInstances`), so recolouring never changes the mapping. */
  materialInstances: Record<string, { texture: string; render_method: RenderMethod }>;
}

/** One profile's served pack and its pieces. */
export interface GeyserProfile {
  project: Project;
  entries: readonly GeyserEntry[];
}

/** Ids for the pack Geyser serves. Derived, so they never equal the local-world pack's ids yet stay stable. */
export function geyserUuids(project: Pick<Project, "uuids">): { rp: string; rpModule: string } {
  return {
    rp: deriveUuid(`blockshop:geyser:rp:${project.uuids.rp}`),
    rpModule: deriveUuid(`blockshop:geyser:rp-module:${project.uuids.rpModule}`),
  };
}

export function itemIconName(namespace: string, id: string): string {
  return `${namespace}_${id}`;
}

/**
 * Custom block mappings v1: one entry per vanilla carrier block (e.g. `minecraft:oak_leaves`), each with
 * `only_override_states` and one state override per piece facing that uses it, across every profile.
 * Geyser turns every entry into one Bedrock block with the Java properties as block properties and one
 * permutation per override.
 *
 * Geyser reads this file at startup only, so everything a kid edits day to day (shape, colours, name)
 * is kept out of it: geometry comes from the served pack, the material list is the whole palette, the
 * boxes are the full cube. It changes only for a new piece or a light change.
 */
export function buildGeyserBlockMappings(entries: readonly GeyserEntry[]) {
  const perBlock = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    for (const f of FACINGS) {
      const state = e.states[f];
      const block = javaBlockOf(state);
      let overrides = perBlock.get(block);
      if (!overrides) { overrides = {}; perBlock.set(block, overrides); }
      const o: Record<string, unknown> = {
        geometry: geometryId(e.project.namespace, e.piece.id),
        material_instances: e.materialInstances,
        // The Java carrier is a full cube server-side; a smaller Bedrock box would let players walk into an invisible wall.
        collision_box: { origin: [-8, 0, -8], size: [16, 16, 16] },
        selection_box: { origin: [-8, 0, -8], size: [16, 16, 16] },
        transformation: { rotation: [0, e.project.java.bedrockYaw[f], 0] },
        destructible_by_mining: 0.6,
      };
      if (e.piece.options.light) o["light_emission"] = e.piece.options.light;
      overrides[stateKey(state)] = o;
    }
  }
  const blocks: Record<string, unknown> = {};
  for (const [block, overrides] of [...perBlock.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(overrides).sort()) sorted[k] = overrides[k];
    blocks[block] = {
      name: `${GEYSER_BLOCK_NAME}_${block.replace(/^minecraft:/, "")}`,
      included_in_creative_inventory: false,
      only_override_states: true,
      state_overrides: sorted,
    };
  }
  return { format_version: 1, blocks };
}

/**
 * Custom item mappings v2: paper + `item_model` → one Bedrock item per piece, icon from that profile's served
 * pack. Deliberately absent from the Bedrock creative inventory: a pickup from there reaches the server as a
 * plain paper without CraftEngine's data and is discarded (verified 2026-09-15). Players get pieces through
 * the BlockshopCatalog plugin's menu (`/cat`) or the `/ce` browser instead.
 */
export function buildGeyserItemMappings(entries: readonly GeyserEntry[]) {
  const definitions: unknown[] = entries.map((e) => {
    const id = blockIdentifier(e.project, e.piece.id);
    return { type: "definition", model: id, bedrock_identifier: id, display_name: e.displayName, bedrock_options: { icon: itemIconName(e.project.namespace, e.piece.id) } };
  });
  const catalog = catalogItemId();
  definitions.push({ type: "definition", model: catalog, bedrock_identifier: catalog, display_name: CATALOG_NAME, bedrock_options: { icon: itemIconName(SHARED_NAMESPACE, CATALOG_ID) } });
  return { format_version: 2, items: { "minecraft:paper": definitions } };
}

/** What the BlockshopCatalog plugin reads (its `pieces.json`): one group per profile with the visible pieces and their served-pack icons. */
export function buildCatalogJson(version: Version, profiles: readonly GeyserProfile[]) {
  return {
    version: version.join("."),
    catalogItem: catalogItemId(),
    ui: {
      title: "Furniture",
      chooseGroup: "Whose furniture?",
      content: "Tap a piece to get it.",
      back: "◀ Back",
      empty: "No furniture yet. Build some in Blockshop!",
      given: "%name% is in your hand. Tap the ground to place it!",
      failed: "Could not give %name%. Ask a grown-up to check the server.",
      tooFar: "Too far away! Walk closer and tap the ground.",
      full: "Your inventory is full, so there is no room for the catalog. Free a slot!",
      pinned: "The catalog is in slot %slot%. Tap it to open the furniture menu.",
      usage: "/cat opens the furniture menu. /cat 1-9 puts the catalog in that slot.",
    },
    groups: profiles.map(({ project, entries }) => ({
      id: project.namespace,
      name: sanitizeDisplayName(project.packName, "Furniture"),
      pieces: entries
        .filter((e) => e.piece.options.hidden !== true)
        .map((e) => ({ id: e.piece.id, item: blockIdentifier(project, e.piece.id), name: e.displayName, icon: `textures/items/${itemIconName(project.namespace, e.piece.id)}` })),
    })),
  };
}

export function buildItemTexture(packName: string, names: readonly string[]) {
  const data: Record<string, { textures: string }> = {};
  for (const n of names) data[n] = { textures: `textures/items/${n}` };
  return { resource_pack_name: packName, texture_name: "atlas.items", texture_data: data };
}

/** The served pack's manifest; `version` is the server export counter, so every update re-downloads. */
export function buildGeyserManifest(project: Project, pieceCount: number, version: Version) {
  const { rp, rpModule } = geyserUuids(project);
  return {
    format_version: 2,
    header: {
      name: `${project.packName} (server)`,
      description: `Blockshop server export v${version.join(".")} · ${pieceCount} piece${pieceCount === 1 ? "" : "s"} · served by Geyser`,
      uuid: rp,
      version,
      min_engine_version: project.minEngineVersion,
    },
    modules: [{ type: "resources", uuid: rpModule, version }],
  };
}
