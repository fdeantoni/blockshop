import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildPack, listZip, sanityCheck, zipMcaddon, previewTree } from "../src/index.js";
import type { FileTree } from "../src/index.js";
import { fixtureIds, piece, project } from "./helpers.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (tree: FileTree) => {
  const enc = new TextEncoder();
  return [...tree.entries()].map(([k, v]) => [k, typeof v === "string" ? enc.encode(v) : v] as const);
};
/** Text files verbatim, binaries as hashes: readable snapshots that still catch every byte change. */
function snapshotOf(tree: FileTree): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of tree) out[k] = typeof v === "string" ? v : `sha256:${sha(v)} (${v.byteLength} bytes)`;
  return out;
}

describe("buildPack", () => {
  const all = fixtureIds().map(piece);

  it("all fixtures together: snapshot of the full tree", () => {
    const { tree, report } = buildPack(project(), all);
    expect(snapshotOf(tree)).toMatchSnapshot();
    expect(report).toMatchSnapshot();
  });

  for (const id of fixtureIds()) {
    it(`fixture ${id}: builds, passes sanity, snapshots its block and geometry`, () => {
      const pr = project();
      const pc = piece(id);
      const result = buildPack(pr, [pc]);
      const s = sanityCheck(pr, [pc], result);
      expect(s.errors).toEqual([]);
      expect(result.tree.get(`family_furniture_bp/blocks/family_${id}.json`)).toMatchSnapshot("block");
      expect(result.tree.get(`family_furniture_rp/models/blocks/family_${id}.geo.json`)).toMatchSnapshot("geometry");
    });
  }

  it("is deterministic: two builds and two zips are byte-identical", () => {
    const a = buildPack(project(), all);
    const b = buildPack(project(), all);
    expect(bytes(a.tree).map(([k, v]) => [k, sha(v)])).toEqual(bytes(b.tree).map(([k, v]) => [k, sha(v)]));
    expect(sha(zipMcaddon(a.tree))).toBe(sha(zipMcaddon(b.tree)));
  });

  it("zip root holds the two pack folders and every tree file", () => {
    const { tree } = buildPack(project(), all);
    const entries = listZip(zipMcaddon(tree));
    expect(entries).toEqual([...tree.keys()].sort());
    expect(new Set(entries.map((e) => e.split("/")[0]))).toEqual(new Set(["family_furniture_bp", "family_furniture_rp"]));
  });

  it("script module only when a piece has a seat", () => {
    const without = buildPack(project(), [piece("table")]);
    expect(without.tree.has("family_furniture_bp/scripts/main.js")).toBe(false);
    expect(JSON.parse(without.tree.get("family_furniture_bp/manifest.json") as string).modules).toHaveLength(1);
    const withSeat = buildPack(project(), [piece("chair_asym")]);
    expect(withSeat.tree.has("family_furniture_bp/scripts/main.js")).toBe(true);
    expect(withSeat.tree.has("family_furniture_rp/entity/seat.entity.json")).toBe(true);
    expect(withSeat.tree.has("family_furniture_rp/render_controllers/seat.render_controllers.json")).toBe(true);
    const client = JSON.parse(withSeat.tree.get("family_furniture_rp/entity/seat.entity.json") as string)["minecraft:client_entity"].description;
    expect(client.render_controllers).toEqual(["controller.render.family_seat"]);
    const manifest = JSON.parse(withSeat.tree.get("family_furniture_bp/manifest.json") as string);
    expect(manifest.modules).toHaveLength(2);
    const script = withSeat.tree.get("family_furniture_bp/scripts/main.js") as string;
    for (const hook of ["onPlace", "onTick", "onPlayerDestroy", "onPlayerInteract", "registerCustomComponent"]) expect(script).toContain(hook);
    expect(withSeat.tree.get("family_furniture_rp/texts/en_US.lang")).toContain("action.interact.sit=");
    expect(withSeat.tree.get("family_furniture_rp/texts/en_US.lang")).toContain("action.hint.action.family:seat=");
    const entity = JSON.parse(withSeat.tree.get("family_furniture_bp/entities/seat.json") as string)["minecraft:entity"].components;
    expect(entity["minecraft:persistent"]).toEqual({});
    expect(entity["minecraft:rideable"].interact_text).toBe("action.interact.sit");
    expect(manifest.dependencies).toContainEqual({ module_name: "@minecraft/server", version: project().scriptApiVersion });
  });

  it("manifest descriptions carry the version and piece count, names stay constant", () => {
    const pr = project();
    pr.version = [1, 0, 7];
    const { tree } = buildPack(pr, [piece("table"), piece("chair_asym")]);
    for (const f of ["family_furniture_bp/manifest.json", "family_furniture_rp/manifest.json"]) {
      const header = JSON.parse(tree.get(f) as string).header;
      expect(header.name).toBe("Family Furniture");
      expect(header.description).toBe("Blockshop v1.0.7 · 2 pieces");
    }
  });

  it("hidden pieces are still emitted", () => {
    const pc = piece("table");
    pc.options.hidden = true;
    const { tree, report } = buildPack(project(), [pc]);
    expect(tree.has("family_furniture_bp/blocks/family_table.json")).toBe(true);
    expect(report.pieces[0]!.hidden).toBe(true);
  });

  it("rejects unknown palette ids, empty pieces and duplicate ids", () => {
    const pc = piece("single_voxel");
    expect(() => buildPack(project(), [{ ...pc, voxels: [{ x: 0, y: 0, z: 0, c: "neon" }] }])).toThrow(/unknown palette/);
    expect(() => buildPack(project(), [{ ...pc, voxels: [] }])).toThrow(/no voxels/);
    expect(() => buildPack(project(), [pc, pc])).toThrow(/duplicate/);
  });

  it("no-merge produces one cube per visible voxel", () => {
    const pr = project();
    pr.generator.merge = false;
    const { report } = buildPack(pr, [piece("single_voxel"), piece("table")]);
    expect(report.pieces.find((p) => p.id === "single_voxel")!.cubesAfterMerge).toBe(1);
    expect(report.pieces.find((p) => p.id === "table")!.cubesAfterMerge).toBe(piece("table").voxels.length);
  });

  it("preview tree is flat and holds geometries plus textures", () => {
    const pv = previewTree(buildPack(project(), [piece("table")]).tree);
    expect([...pv.keys()]).toContain("family_table.geo.json");
    expect([...pv.keys()]).toContain("family_oak.png");
    expect([...pv.keys()].every((k) => !k.includes("/"))).toBe(true);
  });
});

describe("sanityCheck", () => {
  it("flags duplicate ids and bounds problems", () => {
    const pr = project();
    const a = piece("table");
    const result = buildPack(pr, [a]);
    const s = sanityCheck(pr, [a, { ...a, id: "TABLE".toLowerCase() }], result);
    expect(s.errors.some((e) => e.includes("duplicate"))).toBe(true);
    result.report.pieces[0]!.bounds = [-9, 0, 0, 8, 16, 8];
    expect(sanityCheck(pr, [a], result).errors.some((e) => e.includes("leave the block volume"))).toBe(true);
  });
});
