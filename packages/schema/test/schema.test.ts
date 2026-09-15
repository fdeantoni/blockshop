import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PieceSchema, ProjectSchema, newProject, unknownPaletteIds, sanitizeDisplayName, voxelMap, sortVoxels,
} from "../src/index.js";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(fixtures + rel, "utf8"));
const uuids = {
  bp: "11111111-1111-4111-8111-111111111111", rp: "22222222-2222-4222-8222-222222222222",
  bpModule: "33333333-3333-4333-8333-333333333333", rpModule: "44444444-4444-4444-8444-444444444444",
  scriptModule: "55555555-5555-4555-8555-555555555555",
};

describe("ProjectSchema", () => {
  it("parses the fixture project and applies generator defaults", () => {
    const p = ProjectSchema.parse(read("project.json"));
    expect(p.namespace).toBe("family");
    expect(p.generator).toEqual({ mirrorX: true, rotationOffset: 0, merge: true });
  });
  it("newProject fills in current format versions", () => {
    const p = newProject(uuids);
    expect(p.formatVersion).toMatch(/^1\.26\./);
    expect(p.palette.length).toBeGreaterThan(5);
    expect(p.nextPieceNumber).toBe(1);
  });
  it("rejects a bad uuid", () => {
    expect(() => newProject({ ...uuids, bp: "nope" })).toThrow();
  });
});

describe("PieceSchema", () => {
  const files = readdirSync(fixtures + "pieces").filter((f) => f.endsWith(".json"));
  it("has the expected fixtures", () => {
    expect(files.sort()).toEqual(["chair_asym.json", "full_cube.json", "glass_cabinet.json", "single_voxel.json", "table.json"]);
  });
  for (const f of files) {
    it(`parses fixture ${f} with palette ids that exist`, () => {
      const piece = PieceSchema.parse(read("pieces/" + f));
      const project = ProjectSchema.parse(read("project.json"));
      expect(unknownPaletteIds(piece, project.palette)).toEqual([]);
      expect(piece.options).toBeDefined();
    });
  }
  it("rejects out-of-range voxels and bad ids", () => {
    const base = read("pieces/single_voxel.json");
    expect(() => PieceSchema.parse({ ...base, voxels: [{ x: 16, y: 0, z: 0, c: "oak" }] })).toThrow();
    expect(() => PieceSchema.parse({ ...base, id: "Chair-1" })).toThrow();
    expect(() => PieceSchema.parse({ ...base, name: "" })).toThrow();
  });
  it("defaults options to an empty object", () => {
    const base = read("pieces/single_voxel.json");
    delete base.options;
    expect(PieceSchema.parse(base).options).toEqual({});
  });
});

describe("helpers", () => {
  it("sanitizes display names", () => {
    expect(sanitizeDisplayName("  Chair\nfor Alex ", "x")).toBe("Chair for Alex");
    expect(sanitizeDisplayName("## comment", "x")).toBe("comment");
    expect(sanitizeDisplayName("   ", "chair_1")).toBe("chair_1");
  });
  it("voxelMap lets later duplicates win and sortVoxels is stable", () => {
    const m = voxelMap([{ x: 1, y: 2, z: 3, c: "a" }, { x: 1, y: 2, z: 3, c: "b" }]);
    expect(m.get("1,2,3")).toBe("b");
    const s = sortVoxels([{ x: 1, y: 0, z: 0, c: "a" }, { x: 0, y: 0, z: 0, c: "a" }]);
    expect(s[0]?.x).toBe(0);
  });
});
