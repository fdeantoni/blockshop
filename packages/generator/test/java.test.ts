import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { FACINGS, JavaStatesSchema, serverStateKey, type JavaStates, type Piece, type Project } from "@blockshop/schema";
import {
  allocateServerStates, buildServerPack, geyserMcpack, geyserPackNamespaces, geyserMcpackName, listZip, noteBlockStates, NOTE_BLOCK_STATE_COUNT, stateKey, javaBlockOf,
  carrierStates, isCarrierState, LEAVES_STATE_COUNT,
  geyserUuids, deriveUuid, toJavaElement, seatY, miniMessageName, JAVA_DIRS, javaSanityCheck, type ServerBuildInput,
} from "../src/index.js";
import type { FileTree } from "../src/index.js";
import { fixtureIds, piece, project } from "./helpers.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function snapshotOf(tree: FileTree): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of tree) out[k] = typeof v === "string" ? v : `sha256:${sha(v)} (${v.byteLength} bytes)`;
  return out;
}
const json = (tree: FileTree, path: string) => JSON.parse(tree.get(path) as string);
const fresh = (): JavaStates => JavaStatesSchema.parse({});
const keys = (ns: string, pieces: readonly Piece[]) => pieces.map((p) => serverStateKey(ns, p.id));

/** A second profile next to the fixture project: same palette, own namespace and uuids. */
const alex = (): Project => ({
  ...project(), namespace: "alex", packName: "Alex's Furniture",
  uuids: { bp: "11111111-1111-4111-8111-111111111111", rp: "22222222-2222-4222-8222-222222222222", bpModule: "33333333-3333-4333-8333-333333333333", rpModule: "44444444-4444-4444-8444-444444444444", scriptModule: "55555555-5555-4555-8555-555555555555" },
});

/** Family with `familyPieces`, Alex with `alexPieces`, states allocated for all of them. */
function input(familyPieces: Piece[], alexPieces: Piece[] = [], version: [number, number, number] = [1, 0, 3], states?: JavaStates): ServerBuildInput {
  const profiles = [{ project: project(), pieces: familyPieces }, ...(alexPieces.length ? [{ project: alex(), pieces: alexPieces }] : [])];
  const allKeys = profiles.flatMap((p) => keys(p.project.namespace, p.pieces));
  return { version, states: states ?? allocateServerStates(fresh(), allKeys).states, profiles };
}

describe("carrier state allocation", () => {
  it("leaves (default): 143 distinct non-waterlogged states that CraftEngine frees, canonical distance=7/persistent=true excluded", () => {
    const all = carrierStates("leaves");
    expect(all.length).toBe(LEAVES_STATE_COUNT);
    expect(all.length).toBe(143);
    expect(new Set(all).size).toBe(all.length);
    expect(all[0]).toBe("minecraft:azalea_leaves[distance=1,persistent=false,waterlogged=false]");
    expect(all).not.toContain("minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]");
    expect(all.every((s) => s.endsWith("waterlogged=false]"))).toBe(true);
    expect(stateKey(all[0]!)).toBe("distance=1,persistent=false,waterlogged=false");
    expect(javaBlockOf(all[0]!)).toBe("minecraft:azalea_leaves");
    expect(isCarrierState("leaves", all[0]!)).toBe(true);
    expect(isCarrierState("note_block", all[0]!)).toBe(false);
  });

  it("note_block: 1150 distinct canonical states, powered=true and mob heads first", () => {
    const all = noteBlockStates();
    expect(all.length).toBe(NOTE_BLOCK_STATE_COUNT);
    expect(new Set(all).size).toBe(all.length);
    expect(all[0]).toBe("minecraft:note_block[instrument=custom_head,note=0,powered=true]");
    expect(all[all.length - 1]).toBe("minecraft:note_block[instrument=harp,note=24,powered=false]");
  });

  it("assigns four states per namespaced key, in key order, never reassigning or colliding across profiles", () => {
    const first = allocateServerStates(fresh(), ["family:table", "alex:chair", "family:chair_asym"]);
    expect(first.added).toEqual(["alex:chair", "family:chair_asym", "family:table"]);
    expect(first.dropped).toEqual([]);
    expect(first.states.cursor).toBe(12);
    expect(first.states.states["alex:chair"]!.north).toBe(carrierStates("leaves")[0]);
    const second = allocateServerStates(first.states, ["family:chair_asym", "family:glass_cabinet", "alex:chair", "family:table"]);
    expect(second.added).toEqual(["family:glass_cabinet"]);
    expect(second.states.states["alex:chair"]).toEqual(first.states.states["alex:chair"]);
    const used = Object.values(second.states.states).flatMap((s) => FACINGS.map((f) => s[f]));
    expect(new Set(used).size).toBe(16);
    // Keys that are no longer asked for keep their states: a deleted profile's blocks stay what they are.
    const third = allocateServerStates(second.states, ["family:table"]);
    expect(Object.keys(third.states.states)).toHaveLength(4);
    expect(third.added).toEqual([]);
  });

  it("changing the carrier drops the old states and starts over", () => {
    const nb = allocateServerStates({ ...fresh(), carrier: "note_block" }, ["family:table"]).states;
    expect(nb.states["family:table"]!.north).toMatch(/^minecraft:note_block\[/);
    const moved = allocateServerStates({ ...nb, carrier: "leaves" }, ["family:table", "family:chair_asym"]);
    expect(moved.dropped).toEqual(["family:table"]);
    expect(moved.added).toEqual(["family:chair_asym", "family:table"]);
    expect(moved.states.cursor).toBe(8);
  });

  it("refuses when the states run out; three profiles of eleven pieces fit", () => {
    expect(() => allocateServerStates({ ...fresh(), cursor: LEAVES_STATE_COUNT - 2 }, ["family:table"])).toThrow(/no leaves states left/);
    const all = Array.from({ length: 33 }, (_, i) => `p${i % 3}:piece_${Math.floor(i / 3) + 1}`);
    expect(allocateServerStates(fresh(), all).states.cursor).toBe(132);
  });
});

describe("buildServerPack", () => {
  const all = fixtureIds().map(piece);

  it("all fixtures for family plus a table for Alex: snapshot of the full tree", () => {
    const { tree, report } = buildServerPack(input(all, [piece("table")]));
    expect(snapshotOf(tree)).toMatchSnapshot();
    expect(report).toMatchSnapshot();
  });

  it("requires allocated states and rejects bad input like buildPack", () => {
    const pc = piece("table");
    expect(() => buildServerPack({ ...input([pc]), states: fresh() })).toThrow(/no Java block states/);
    const ok = input([pc]);
    expect(() => buildServerPack({ ...ok, profiles: [{ project: project(), pieces: [{ ...pc, voxels: [] }] }] })).toThrow(/no voxels/);
    expect(() => buildServerPack({ ...ok, profiles: [{ project: project(), pieces: [pc, pc] }] })).toThrow(/duplicate piece/);
    expect(() => buildServerPack({ ...ok, profiles: [{ project: project(), pieces: [pc] }, { project: project(), pieces: [] }] })).toThrow(/duplicate namespace/);
    expect(() => buildServerPack({ ...ok, profiles: [{ project: { ...project(), namespace: "blockshop" }, pieces: [] }] })).toThrow(/reserved/);
  });

  it("CraftEngine: every profile's paper block_items in one config, a category per profile, one shared catalog item", () => {
    const inp = input([piece("chair_asym")], [piece("table")]);
    const { tree } = buildServerPack(inp);
    const cfg = json(tree, `${JAVA_DIRS.craftengine}/configuration/blockshop.json`);
    expect(Object.keys(cfg.items).sort()).toEqual(["alex:table", "blockshop:catalog", "family:chair_asym"]);
    const item = cfg.items["family:chair_asym"];
    expect(item.material).toBe("paper");
    expect(item.item_model).toBe("family:chair_asym");
    expect(item.model).toBe("family:block/chair_asym");
    expect(item.data.item_name).toBe(`<!i>${piece("chair_asym").name}`);
    const block = item.behavior.block;
    const st = inp.states.states["family:chair_asym"]!;
    for (const f of FACINGS) {
      expect(block.states.appearances[f].state).toBe(st[f]);
      expect(block.states.appearances[f].model).toEqual({ path: "family:block/chair_asym", y: project().java.yaw[f] });
      expect(block.states.variants[`facing=${f}`]).toEqual({ appearance: f });
    }
    expect(block.settings.sounds.place).toBe("minecraft:block.wood.place");
    expect(block.behavior).toEqual({ type: "seat_block", seats: ["0,0.3125,0"] });
    expect(cfg.items["alex:table"].model).toBe("alex:block/table");
    expect(cfg.categories["alex:furniture"]).toEqual({ name: "<!i>Alex's Furniture", icon: "alex:table", priority: 0, source: { type: "list", list: ["alex:table"] } });
    expect(cfg.categories["family:furniture"]).toMatchObject({ name: "<!i>Family Furniture", priority: 1, source: { type: "list", list: ["family:chair_asym"] } });
    expect(cfg.items["blockshop:catalog"]).toMatchObject({ material: "paper", item_model: "blockshop:catalog", texture: "blockshop:item/catalog", data: { max_stack_size: 1 } });
    expect(tree.has(`${JAVA_DIRS.craftengine}/resourcepack/assets/blockshop/textures/item/catalog.png`)).toBe(true);
    expect(tree.get(`${JAVA_DIRS.craftengine}/pack.yml`)).toContain("namespace: blockshop");
    expect(tree.has(`${JAVA_DIRS.craftengine}/resourcepack/assets/family/textures/block/family_oak.png`)).toBe(true);
    expect(tree.has(`${JAVA_DIRS.craftengine}/resourcepack/assets/alex/textures/block/alex_oak.png`)).toBe(true);
    expect(tree.has(`${JAVA_DIRS.craftengine}/resourcepack/assets/alex/models/block/table.json`)).toBe(true);
  });

  it("Java model: editor coordinates unmirrored, per-face texture references, block/block parent", () => {
    const pc = piece("single_voxel");
    const { tree } = buildServerPack(input([pc]));
    const model = json(tree, `${JAVA_DIRS.craftengine}/resourcepack/assets/family/models/block/single_voxel.json`);
    expect(model.parent).toBe("minecraft:block/block");
    const v = pc.voxels[0]!;
    expect(model.elements).toHaveLength(1);
    expect(model.elements[0].from).toEqual([v.x, v.y, v.z]);
    expect(model.elements[0].faces.up).toEqual({ uv: [0, 0, 1, 1], texture: `#${v.c}` });
    expect(model.textures[v.c]).toBe(`family:block/family_${v.c}`);
    expect(toJavaElement({ x: 3, y: 0, z: 10, sx: 2, sy: 4, sz: 5, c: "oak", faces: ["east"] }).faces.east).toEqual({ uv: [0, 0, 5, 4], texture: "#oak" });
  });

  it("Geyser blocks: one entry per carrier block across profiles, only_override_states, canonical keys, Bedrock yaw table", () => {
    const inp = input([piece("chair_asym")], [piece("table")]);
    const { tree } = buildServerPack(inp);
    const m = json(tree, `${JAVA_DIRS.geyser}/custom_mappings/blockshop_blocks.json`);
    expect(m.format_version).toBe(1);
    expect(Object.keys(m.blocks)).toEqual(["minecraft:azalea_leaves"]); // 8 states fit in the first leaf type
    const nb = m.blocks["minecraft:azalea_leaves"];
    expect(nb.name).toBe("blockshop_azalea_leaves");
    expect(nb.only_override_states).toBe(true);
    expect(nb.included_in_creative_inventory).toBe(false);
    expect(Object.keys(nb.state_overrides)).toHaveLength(8);
    const west = nb.state_overrides[stateKey(inp.states.states["family:chair_asym"]!.west)];
    expect(west.geometry).toBe("geometry.family.chair_asym");
    expect(west.transformation).toEqual({ rotation: [0, 270, 0] });
    expect(west.collision_box).toEqual({ origin: [-8, 0, -8], size: [16, 16, 16] });
    expect(west.material_instances["*"]).toEqual({ texture: "family_oak", render_method: "opaque" });
    const alexSouth = nb.state_overrides[stateKey(inp.states.states["alex:table"]!.south)];
    expect(alexSouth.geometry).toBe("geometry.alex.table");
    expect(alexSouth.material_instances["*"].texture).toBe("alex_oak"); // "*" is always the first palette entry (stable mapping)
    expect(json(tree, `${JAVA_DIRS.geyserRp}/alex/models/blocks/alex_table.geo.json`)["minecraft:geometry"][0].description.identifier).toBe("geometry.alex.table");
  });

  it("Geyser items and the catalog: definitions across profiles keyed by item_model, grouped pieces.json, icons from thumbnails", () => {
    const table = piece("table");
    const hidden = { ...piece("chair_asym"), options: { ...piece("chair_asym").options, hidden: true } };
    const inp = input([table, hidden], [piece("glass_cabinet")]);
    inp.profiles[0]!.thumbnails = new Map([["table", new Uint8Array([1, 2, 3])]]);
    const { tree, report } = buildServerPack(inp);
    const m = json(tree, `${JAVA_DIRS.geyser}/custom_mappings/blockshop_items.json`);
    expect(m.format_version).toBe(2);
    const defs = m.items["minecraft:paper"];
    expect(defs.map((d: { model: string }) => d.model)).toEqual(["alex:glass_cabinet", "family:chair_asym", "family:table", "blockshop:catalog"]);
    expect(defs[3]).toEqual({ type: "definition", model: "blockshop:catalog", bedrock_identifier: "blockshop:catalog", display_name: "Furniture catalog", bedrock_options: { icon: "blockshop_catalog" } });
    expect(defs[2]).toEqual({ type: "definition", model: "family:table", bedrock_identifier: "family:table", display_name: table.name, bedrock_options: { icon: "family_table" } });
    expect(JSON.stringify(m)).not.toContain("creative_category");
    // Every served pack carries the catalog icon; the client stacks them.
    for (const ns of ["alex", "family"]) {
      expect(tree.has(`${JAVA_DIRS.geyserRp}/${ns}/textures/items/blockshop_catalog.png`)).toBe(true);
      expect(json(tree, `${JAVA_DIRS.geyserRp}/${ns}/textures/item_texture.json`).texture_data["blockshop_catalog"]).toEqual({ textures: "textures/items/blockshop_catalog" });
    }
    expect(tree.get(`${JAVA_DIRS.geyserRp}/family/textures/items/family_table.png`)).toEqual(new Uint8Array([1, 2, 3]));
    const catalog = json(tree, `${JAVA_DIRS.catalog}/pieces.json`);
    expect(catalog).toMatchObject({ version: "1.0.3", catalogItem: "blockshop:catalog", ui: { title: "Furniture", chooseGroup: "Whose furniture?" } });
    expect(catalog.groups).toEqual([
      { id: "alex", name: "Alex's Furniture", pieces: [{ id: "glass_cabinet", item: "alex:glass_cabinet", name: piece("glass_cabinet").name, icon: "textures/items/alex_glass_cabinet" }] },
      { id: "family", name: "Family Furniture", pieces: [{ id: "table", item: "family:table", name: table.name, icon: "textures/items/family_table" }] }, // hidden chair left out
    ]);
    expect(report.profiles.map((p) => p.namespace)).toEqual(["alex", "family"]);
    expect(report.profiles[1]!.pieces.map((p) => p.icon)).toEqual(["generated", "thumbnail"]);
    // Hidden pieces still get a block mapping: placed furniture must keep rendering.
    const blocks = json(tree, `${JAVA_DIRS.geyser}/custom_mappings/blockshop_blocks.json`);
    expect(Object.keys(blocks.blocks["minecraft:azalea_leaves"].state_overrides)).toHaveLength(12);
  });

  it("served packs: one per profile with derived uuids and the export version; mcpacks hold each pack at its root", () => {
    const inp = input(all, [piece("table")], [1, 0, 9]);
    const { tree } = buildServerPack(inp);
    expect(geyserPackNamespaces(tree)).toEqual(["alex", "family"]);
    for (const ns of ["alex", "family"]) {
      const pr = ns === "alex" ? alex() : project();
      const manifest = json(tree, `${JAVA_DIRS.geyserRp}/${ns}/manifest.json`);
      const ids = geyserUuids(pr);
      expect(manifest.header.uuid).toBe(ids.rp);
      expect(manifest.header.name).toBe(`${pr.packName} (server)`);
      expect(manifest.header.version).toEqual([1, 0, 9]);
      expect(Object.values(pr.uuids)).not.toContain(ids.rp);
      const entries = listZip(geyserMcpack(tree, ns));
      expect(entries).toContain("manifest.json");
      expect(entries).toContain("textures/terrain_texture.json");
      expect(entries.every((e) => !e.startsWith(JAVA_DIRS.geyserRp))).toBe(true);
    }
    expect(geyserUuids(alex()).rp).not.toBe(geyserUuids(project()).rp);
    expect(geyserMcpackName("alex")).toBe("blockshop_alex.mcpack");
    expect(deriveUuid("x")).toBe(deriveUuid("x"));
  });

  it("Geyser block mapping is stable under shape, colour and name edits; glass flips the render method", () => {
    const table = piece("table");
    const inp = input([table]);
    const file = `${JAVA_DIRS.geyser}/custom_mappings/blockshop_blocks.json`;
    const before = buildServerPack(inp).tree.get(file);
    const edited = { ...table, name: "Kitchen table", voxels: [...table.voxels.slice(0, 100).map((v) => ({ ...v, c: "red" })), ...table.voxels.slice(100), { x: 15, y: 15, z: 15, c: "black" }] };
    expect(buildServerPack({ ...inp, profiles: [{ project: project(), pieces: [edited] }] }).tree.get(file)).toBe(before);
    const glassy = { ...table, voxels: table.voxels.map((v, i) => (i === 0 ? { ...v, c: "glass" } : v)) };
    const m = json(buildServerPack({ ...inp, profiles: [{ project: project(), pieces: [glassy] }] }).tree, file);
    const first = Object.values(m.blocks)[0] as any;
    const override = Object.values(first.state_overrides)[0] as any;
    expect(override.material_instances["*"].render_method).toBe("blend");
  });

  it("spreads pieces over several leaf types once one is used up, one Geyser entry per block", () => {
    const pcs = [piece("chair_asym"), piece("table")];
    const states = allocateServerStates({ ...fresh(), cursor: 12 }, keys("family", pcs)).states; // 13 azalea states: the next piece straddles two leaf types
    const inp = input(pcs, [], [1, 0, 3], states);
    const { tree } = buildServerPack(inp);
    const m = json(tree, `${JAVA_DIRS.geyser}/custom_mappings/blockshop_blocks.json`);
    expect(Object.keys(m.blocks)).toEqual(["minecraft:azalea_leaves", "minecraft:flowering_azalea_leaves"]);
    expect(Object.values(m.blocks).reduce((n: number, b: any) => n + Object.keys(b.state_overrides).length, 0)).toBe(8);
    expect(javaSanityCheck(inp, buildServerPack(inp)).errors).toEqual([]);
  });

  it("passes its own sanity checks, which catch dangling references and shared states", () => {
    const inp = input(all, [piece("table")]);
    const result = buildServerPack(inp);
    expect(javaSanityCheck(inp, result).errors).toEqual([]);
    const broken = new Map(result.tree);
    broken.delete(`${JAVA_DIRS.geyserRp}/family/models/blocks/family_table.geo.json`);
    expect(javaSanityCheck(inp, { ...result, tree: broken }).errors.some((e) => e.includes("geometry.family.table"))).toBe(true);
    const shared = structuredClone(inp);
    shared.states.states["alex:table"] = shared.states.states["family:chair_asym"]!;
    expect(javaSanityCheck(shared, result).errors.some((e) => e.includes("also used by"))).toBe(true);
    const noIcon = new Map(result.tree);
    noIcon.delete(`${JAVA_DIRS.geyserRp}/alex/textures/items/alex_table.png`);
    expect(javaSanityCheck(inp, { ...result, tree: noIcon }).errors.some((e) => e.includes("icon file"))).toBe(true);
  });

  it("is deterministic", () => {
    const inp = input(all, [piece("table")]);
    const a = buildServerPack(inp);
    const b = buildServerPack(inp);
    expect(snapshotOf(a.tree)).toEqual(snapshotOf(b.tree));
    expect(sha(geyserMcpack(a.tree, "alex"))).toBe(sha(geyserMcpack(b.tree, "alex")));
  });

  it("helpers: seat y and MiniMessage names", () => {
    expect(seatY(5, 0)).toBe("0.3125");
    expect(seatY(5, 0.1)).toBe("0.4125");
    expect(miniMessageName("<red>Alex's chair</red>", "x")).toBe("<!i>redAlex's chair/red");
    expect(miniMessageName("   ", "piece_1")).toBe("<!i>piece_1");
  });
});
