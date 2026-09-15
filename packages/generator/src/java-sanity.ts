import { FACINGS, serverStateKey } from "@blockshop/schema";
import { GEYSER_BLOCKS_FILE, GEYSER_ITEMS_FILE } from "./geyser.js";
import { CATALOG_JSON, JAVA_DIRS, type JavaBuildResult, type ServerBuildInput } from "./java-pack.js";
import { CRAFTENGINE_CONFIG_FILE } from "./craftengine.js";
import { isCarrierState, javaBlockOf, stateKey } from "./java-states.js";
import type { SanityResult } from "./sanity.js";

/**
 * Cross-file checks on the family-server export: every Geyser reference (geometry, texture, icon, item model)
 * resolves inside that profile's served pack or the CraftEngine config, and no two pieces share a carrier state.
 */
export function javaSanityCheck(input: ServerBuildInput, result: JavaBuildResult): SanityResult {
  const errors: string[] = [];
  const warnings: string[] = [...result.report.warnings];
  const { tree } = result;
  const text = (path: string): string | undefined => {
    const v = tree.get(path);
    return typeof v === "string" ? v : undefined;
  };
  const json = (path: string): unknown => {
    const t = text(path);
    if (t === undefined) { errors.push(`missing ${path}`); return undefined; }
    try { return JSON.parse(t); } catch (e) { errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); return undefined; }
  };

  const blocks = json(`${JAVA_DIRS.geyser}/${GEYSER_BLOCKS_FILE}`) as { blocks?: Record<string, { state_overrides?: Record<string, Record<string, unknown>> }> } | undefined;
  const overrideFor = (state: string) => blocks?.blocks?.[javaBlockOf(state)]?.state_overrides?.[stateKey(state)];
  const overrideCount = Object.values(blocks?.blocks ?? {}).reduce((n, b) => n + Object.keys(b.state_overrides ?? {}).length, 0);
  const items = json(`${JAVA_DIRS.geyser}/${GEYSER_ITEMS_FILE}`) as { items?: Record<string, Array<{ model: string; bedrock_options?: { icon?: string } }>> } | undefined;
  const ce = json(`${JAVA_DIRS.craftengine}/${CRAFTENGINE_CONFIG_FILE}`) as { items?: Record<string, { item_model?: string; model?: string }> } | undefined;

  const seen = new Map<string, string>();
  let total = 0;
  const iconFiles = new Set<string>();
  const iconNames = new Set<string>();
  for (const { project, pieces } of input.profiles) {
    const ns = project.namespace;
    const rp = `${JAVA_DIRS.geyserRp}/${ns}`;
    const terrain = json(`${rp}/textures/terrain_texture.json`) as { texture_data?: Record<string, unknown> } | undefined;
    const itemTex = json(`${rp}/textures/item_texture.json`) as { texture_data?: Record<string, unknown> } | undefined;
    for (const n of Object.keys(itemTex?.texture_data ?? {})) { iconNames.add(n); if (tree.has(`${rp}/textures/items/${n}.png`)) iconFiles.add(n); }
    const geometries = new Set<string>();
    for (const [path, content] of tree) {
      if (!path.startsWith(`${rp}/models/blocks/`) || typeof content !== "string") continue;
      try { geometries.add((JSON.parse(content) as { "minecraft:geometry": Array<{ description: { identifier: string } }> })["minecraft:geometry"][0]!.description.identifier); } catch { errors.push(`${path}: unreadable geometry`); }
    }
    // Carrier states: unique across every profile, on the configured carrier, and present in the Geyser mapping.
    for (const p of pieces) {
      total++;
      const key = serverStateKey(ns, p.id);
      const states = input.states.states[key];
      if (!states) { errors.push(`${key}: no Java states`); continue; }
      for (const f of FACINGS) {
        const s = states[f];
        const owner = seen.get(s);
        if (owner) errors.push(`${key}: state ${s} is also used by ${owner}`);
        seen.set(s, key);
        if (!isCarrierState(input.states.carrier, s)) errors.push(`${key}: state ${s} is not a ${input.states.carrier} state`);
        const o = overrideFor(s);
        if (!o) { errors.push(`${key}: no Geyser override for ${s}`); continue; }
        const geo = o["geometry"] as string | undefined;
        if (!geo || !geometries.has(geo)) errors.push(`${key}: Geyser override references geometry ${geo} which the served pack does not define`);
        const mi = o["material_instances"] as Record<string, { texture: string }> | undefined;
        for (const [k, v] of Object.entries(mi ?? {})) if (!terrain?.texture_data?.[v.texture]) errors.push(`${key}: material instance ${k} uses texture ${v.texture} missing from terrain_texture.json`);
      }
    }
  }
  if (overrideCount !== total * FACINGS.length) errors.push(`Geyser mapping has ${overrideCount} overrides for ${total} pieces`);

  // Items: every Geyser definition has a CraftEngine item with the same item_model, an icon in some served pack and a model file.
  const defs = items?.items?.["minecraft:paper"] ?? [];
  for (const d of defs) {
    const ceItem = ce?.items?.[d.model];
    if (!ceItem) errors.push(`Geyser item ${d.model} has no CraftEngine item`);
    else if (ceItem.item_model !== d.model) errors.push(`CraftEngine item ${d.model} has item_model ${ceItem.item_model}`);
    const icon = d.bedrock_options?.icon;
    if (!icon || !iconNames.has(icon)) errors.push(`Geyser item ${d.model}: icon ${icon} missing from every item_texture.json`);
    else if (!iconFiles.has(icon)) errors.push(`Geyser item ${d.model}: icon file ${icon}.png missing`);
    const model = ceItem?.model;
    if (model) {
      const [ns, path] = model.split(":");
      if (!tree.has(`${JAVA_DIRS.craftengine}/resourcepack/assets/${ns}/models/${path}.json`)) errors.push(`CraftEngine item ${d.model}: model ${model} has no file`);
    }
  }
  if (defs.length !== total + 1) errors.push(`Geyser item mapping has ${defs.length} definitions for ${total} pieces plus the catalog`);
  const catalog = json(`${JAVA_DIRS.catalog}/${CATALOG_JSON}`) as { catalogItem?: string; groups?: Array<{ id: string; pieces: Array<{ item: string; icon: string }> }> } | undefined;
  if (catalog) {
    if (!ce?.items?.[catalog.catalogItem ?? ""]) errors.push(`catalog item ${catalog.catalogItem} has no CraftEngine item`);
    for (const g of catalog.groups ?? []) {
      for (const c of g.pieces) {
        if (!ce?.items?.[c.item]) errors.push(`catalog lists ${c.item}, which has no CraftEngine item`);
        if (!tree.has(`${JAVA_DIRS.geyserRp}/${g.id}/${c.icon}.png`)) errors.push(`catalog icon ${c.icon} missing from the served pack of ${g.id}`);
      }
    }
  }

  return { errors, warnings };
}
