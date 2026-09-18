import { describe, it, expect } from "vitest";
import type { Piece, Project } from "@blockshop/schema";
import {
  buildDevPacks, buildPack, devArchiveName, devFolderName, devPackName, devPackUuids, devProfileSubtree,
  listZip, zipMcaddon, DEV_ARCHIVE_ALL, DEV_ARCHIVE_DIRS, DEV_PACK_VERSION, type DevBuildInput,
} from "../src/index.js";
import { fixtureIds, piece, project } from "./helpers.js";

/** A second profile next to the fixture project: same palette, own namespace and uuids. */
const alex = (): Project => ({
  ...project(), namespace: "alex", packName: "Alex's Furniture",
  uuids: { bp: "11111111-1111-4111-8111-111111111111", rp: "22222222-2222-4222-8222-222222222222", bpModule: "33333333-3333-4333-8333-333333333333", rpModule: "44444444-4444-4444-8444-444444444444", scriptModule: "55555555-5555-4555-8555-555555555555" },
});

const input = (familyPieces: Piece[], alexPieces: Piece[] = []): DevBuildInput => ({
  profiles: [{ project: project(), pieces: familyPieces }, ...(alexPieces.length ? [{ project: alex(), pieces: alexPieces }] : [])],
});
const json = (tree: Map<string, string | Uint8Array>, path: string) => JSON.parse(tree.get(path) as string);
const bpPath = (ns: string, rest: string) => `${DEV_ARCHIVE_DIRS.bp}/${devFolderName(ns, "bp")}/${rest}`;
const rpPath = (ns: string, rest: string) => `${DEV_ARCHIVE_DIRS.rp}/${devFolderName(ns, "rp")}/${rest}`;

describe("buildDevPacks", () => {
  it("one pack per profile, in the folders the device saves them to", () => {
    const { tree, report } = buildDevPacks(input([piece("table"), piece("chair_asym")], [piece("table")]));
    expect(report.profiles.map((p) => p.namespace)).toEqual(["alex", "family"]);
    expect(tree.has(bpPath("family", "blocks/family_table.json"))).toBe(true);
    expect(tree.has(bpPath("alex", "blocks/alex_table.json"))).toBe(true);
    expect(tree.has(rpPath("alex", "models/blocks/alex_table.geo.json"))).toBe(true);
    expect(tree.has(bpPath("alex", "manifest.json"))).toBe(true);
    // Nothing of one profile leaks into another's pack: each is complete on its own.
    expect(json(tree, rpPath("alex", "blocks.json"))).toHaveProperty("alex:table");
    expect(json(tree, rpPath("alex", "blocks.json"))).not.toHaveProperty("family:table");
    expect(report.profiles.find((p) => p.namespace === "alex")!.folders).toEqual({ bp: "blockshop_alex_bp", rp: "blockshop_alex_rp" });
  });

  it("each pack is the profile's own pack, only with live ids, a fixed version and a marked name", () => {
    const pieces = [piece("chair_asym")];
    const { tree } = buildDevPacks(input(pieces));
    const pr = project();
    const manifest = json(tree, bpPath("family", "manifest.json"));
    expect(manifest.header.name).toBe(devPackName(pr.packName));
    expect(manifest.header.name).toBe("Family Furniture (live)");
    expect(manifest.header.version).toEqual(DEV_PACK_VERSION);
    expect(manifest.header.uuid).toBe(devPackUuids(pr).bp);
    // Never the imported pack's ids: two packs with one uuid are one pack to Minecraft.
    expect(manifest.header.uuid).not.toBe(pr.uuids.bp);

    // Same blocks, geometry and seat script as the .mcaddon that profile publishes.
    const own = buildPack(pr, pieces).tree;
    for (const [path, content] of own) {
      const [, ...rest] = path.split("/");
      const kind = path.includes("_bp/") ? "bp" : "rp";
      const live = tree.get(`${DEV_ARCHIVE_DIRS[kind]}/${devFolderName("family", kind)}/${rest.join("/")}`);
      // The two files that carry the pack's identity differ by design; everything else is byte-identical.
      if (rest.join("/") === "manifest.json" || rest.join("/") === "textures/terrain_texture.json") continue;
      expect(live, path).toEqual(content);
    }
  });

  it("seats come from the pack builder, unchanged", () => {
    const { tree, report } = buildDevPacks(input([piece("chair_asym")]));
    expect(tree.has(bpPath("family", "entities/seat.json"))).toBe(true);
    expect(tree.has(bpPath("family", "scripts/main.js"))).toBe(true);
    expect(tree.get(bpPath("family", "scripts/main.js"))).toBe(buildPack(project(), [piece("chair_asym")]).tree.get("family_furniture_bp/scripts/main.js"));
    expect(report.profiles[0]!.pieces[0]!.seat).toBe(true);
  });

  it("skips what it cannot build instead of throwing, because it runs on live edits", () => {
    const empty = { ...piece("table"), id: "empty_one", voxels: [] } as Piece;
    const stale = { ...piece("table"), id: "stale_one", voxels: [{ x: 0, y: 0, z: 0, c: "gold" }] } as unknown as Piece;
    const { tree, report } = buildDevPacks(input([piece("table"), empty, stale]));
    expect(report.profiles[0]!.skipped).toEqual([
      { id: "empty_one", reason: "no voxels yet" },
      { id: "stale_one", reason: "unknown palette ids: gold" },
    ]);
    expect(report.profiles[0]!.pieces.map((p) => p.id)).toEqual(["table"]);
    expect(tree.has(bpPath("family", "blocks/family_empty_one.json"))).toBe(false);
  });

  it("a profile with nothing drawn yet still gets a pack, so its folder is never stale", () => {
    const { tree, report } = buildDevPacks(input([piece("table")], []));
    expect(tree.has(bpPath("family", "manifest.json"))).toBe(true);
    expect(report.profiles).toHaveLength(1);
  });

  it("one archive holds everyone, and a profile's own archive holds only that profile", () => {
    const { tree } = buildDevPacks(input(fixtureIds().map((id) => piece(id)), [piece("table")]));
    const all = listZip(zipMcaddon(tree));
    expect(all.some((n) => n.startsWith(`${DEV_ARCHIVE_DIRS.bp}/blockshop_family_bp/`))).toBe(true);
    expect(all.some((n) => n.startsWith(`${DEV_ARCHIVE_DIRS.bp}/blockshop_alex_bp/`))).toBe(true);

    const mine = listZip(zipMcaddon(devProfileSubtree(tree, "alex")));
    expect(mine.every((n) => n.includes("blockshop_alex_"))).toBe(true);
    expect(mine).toContain(`${DEV_ARCHIVE_DIRS.bp}/blockshop_alex_bp/manifest.json`);
    expect(mine).toContain(`${DEV_ARCHIVE_DIRS.rp}/blockshop_alex_rp/manifest.json`);
    expect(devArchiveName("alex")).toBe("blockshop_alex.zip");
    expect(DEV_ARCHIVE_ALL).toBe("blockshop-all.zip");
    // A profile called "Family" must not be able to claim the everyone archive's name.
    expect(devArchiveName("family")).not.toBe(DEV_ARCHIVE_ALL);
  });

  it("is pure and deterministic, and refuses two profiles with one namespace", () => {
    const a = buildDevPacks(input([piece("table")], [piece("table")])).tree;
    const b = buildDevPacks(input([piece("table")], [piece("table")])).tree;
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect(a.get(bpPath("family", "blocks/family_table.json"))).toBe(b.get(bpPath("family", "blocks/family_table.json")));
    expect(() => buildDevPacks({ profiles: [{ project: project(), pieces: [piece("table")] }, { project: project(), pieces: [piece("table")] }] }))
      .toThrow(/duplicate namespace/);
  });
});
