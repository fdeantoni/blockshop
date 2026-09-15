import { describe, it, expect } from "vitest";
import { buildBlock, buildMesh, paletteUsage, toCube } from "../src/index.js";
import { piece, project } from "./helpers.js";

function block(id: string, mutate: (p: ReturnType<typeof project>, pc: ReturnType<typeof piece>) => void = () => {}) {
  const pr = project();
  const pc = piece(id);
  mutate(pr, pc);
  const palette = new Map(pr.palette.map((p) => [p.id, p]));
  const cubes = buildMesh(pc.voxels, pr.palette, pr.generator.merge).map((b) => toCube(b, pr.generator.mirrorX));
  return buildBlock({ project: pr, piece: pc, cubes, usage: paletteUsage(pc), palette });
}

describe("buildBlock", () => {
  it("single voxel: tight collision box and opaque material instances", () => {
    const b = block("single_voxel");
    const c = b.json["minecraft:block"].components as Record<string, any>;
    // Editor (7,0,7) with the default x mirror lands at model x 0..1.
    expect(c["minecraft:collision_box"]).toEqual({ origin: [0, 0, -1], size: [1, 1, 1] });
    expect((block("single_voxel", (pr) => { pr.generator.mirrorX = false; }).json["minecraft:block"].components as Record<string, any>)["minecraft:collision_box"]).toEqual({ origin: [-1, 0, -1], size: [1, 1, 1] });
    expect(c["minecraft:selection_box"]).toEqual(c["minecraft:collision_box"]);
    expect(c["minecraft:material_instances"]).toEqual({
      "*": { texture: "family_red", render_method: "opaque" },
      red: { texture: "family_red", render_method: "opaque" },
    });
    expect(c["minecraft:map_color"]).toBe("#c4302c");
    expect(b.json.format_version).toBe(project().formatVersion);
    expect(b.json["minecraft:block"].permutations).toHaveLength(4);
  });
  it("chair with seat gets the custom component with its height", () => {
    const b = block("chair_asym");
    const c = b.json["minecraft:block"].components as Record<string, any>;
    expect(c["family:seat"]).toEqual({ height: 5 });
    expect(c["minecraft:tick"]).toEqual({ interval_range: [100, 100], looping: true });
    expect(b.seat).toBe(true);
    expect(block("table").json["minecraft:block"].components["minecraft:tick" as never]).toBeUndefined();
    expect(b.sound).toBe("wood");
  });
  it("glass cabinet uses blend for every instance and emits light", () => {
    const b = block("glass_cabinet");
    const c = b.json["minecraft:block"].components as Record<string, any>;
    const methods = new Set(Object.values(c["minecraft:material_instances"] as Record<string, { render_method: string }>).map((m) => m.render_method));
    expect([...methods]).toEqual(["blend"]);
    expect(c["minecraft:light_emission"]).toBe(7);
  });
  it("hidden pieces leave the creative menu but keep their identifier", () => {
    const b = block("table", (_, pc) => { pc.options.hidden = true; });
    expect(b.json["minecraft:block"].description.menu_category).toEqual({ category: "none", is_hidden_in_commands: true });
    expect(b.identifier).toBe("family:table");
  });
  it("rotation offset is emitted only when set", () => {
    const off = block("table").json["minecraft:block"].description.traits["minecraft:placement_direction"] as Record<string, unknown>;
    expect(off["y_rotation_offset"]).toBeUndefined();
    const on = block("table", (pr) => { pr.generator.rotationOffset = 180; }).json["minecraft:block"].description.traits["minecraft:placement_direction"] as Record<string, unknown>;
    expect(on["y_rotation_offset"]).toBe(180);
  });
});
