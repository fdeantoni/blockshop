import { describe, it, expect } from "vitest";
import { VoxelModel, neighborCell, inGrid } from "../src/model.js";

describe("VoxelModel", () => {
  it("places, removes and round-trips through sorted voxels", () => {
    const m = new VoxelModel();
    expect(m.place({ x: 3, y: 0, z: 2 }, "oak")).toBe(true);
    expect(m.place({ x: 3, y: 0, z: 2 }, "oak")).toBe(false); // no change, no history entry
    expect(m.place({ x: 0, y: 1, z: 0 }, "red")).toBe(true);
    expect(m.toVoxels()).toEqual([{ x: 3, y: 0, z: 2, c: "oak" }, { x: 0, y: 1, z: 0, c: "red" }]);
    expect(m.remove({ x: 3, y: 0, z: 2 })).toBe(true);
    expect(m.remove({ x: 3, y: 0, z: 2 })).toBe(false);
    expect(m.size).toBe(1);
    expect(VoxelModel.fromVoxels(m.toVoxels()).toVoxels()).toEqual(m.toVoxels());
  });

  it("ignores off-grid writes", () => {
    const m = new VoxelModel();
    expect(m.place({ x: 16, y: 0, z: 0 }, "oak")).toBe(false);
    expect(m.place({ x: 0, y: -1, z: 0 }, "oak")).toBe(false);
    expect(m.size).toBe(0);
  });

  it("undo/redo restore exact states and redo clears on new edits", () => {
    const m = new VoxelModel();
    m.place({ x: 1, y: 1, z: 1 }, "oak");
    m.place({ x: 1, y: 1, z: 1 }, "red"); // recolour
    m.place({ x: 2, y: 1, z: 1 }, "blue");
    const s3 = m.toVoxels();
    expect(m.undo()).toBe(true);
    expect(m.toVoxels()).toEqual([{ x: 1, y: 1, z: 1, c: "red" }]);
    expect(m.undo()).toBe(true);
    expect(m.toVoxels()).toEqual([{ x: 1, y: 1, z: 1, c: "oak" }]);
    expect(m.redo()).toBe(true);
    expect(m.redo()).toBe(true);
    expect(m.toVoxels()).toEqual(s3);
    expect(m.redo()).toBe(false);
    m.undo();
    m.place({ x: 5, y: 5, z: 5 }, "oak");
    expect(m.canRedo).toBe(false);
    expect(m.undo() && m.undo() && m.undo()).toBe(true);
    expect(m.size).toBe(0);
    expect(m.undo()).toBe(false);
  });

  it("mirrorX twice is identity and is one undo step", () => {
    const m = VoxelModel.fromVoxels([{ x: 0, y: 0, z: 0, c: "oak" }, { x: 1, y: 2, z: 3, c: "red" }, { x: 15, y: 0, z: 0, c: "blue" }]);
    const before = m.toVoxels();
    expect(m.mirrorX()).toBe(true);
    expect(m.toVoxels()).toEqual([{ x: 0, y: 0, z: 0, c: "blue" }, { x: 15, y: 0, z: 0, c: "oak" }, { x: 14, y: 2, z: 3, c: "red" }]);
    m.mirrorX();
    expect(m.toVoxels()).toEqual(before);
    m.undo();
    m.undo();
    expect(m.toVoxels()).toEqual(before);
    const sym = VoxelModel.fromVoxels([{ x: 7, y: 0, z: 0, c: "oak" }, { x: 8, y: 0, z: 0, c: "oak" }]);
    expect(sym.mirrorX()).toBe(false);
  });

  it("reset drops history and notifies listeners", () => {
    const m = new VoxelModel();
    let n = 0;
    m.onChange(() => n++);
    m.place({ x: 0, y: 0, z: 0 }, "oak");
    m.reset([{ x: 2, y: 2, z: 2, c: "red" }]);
    expect(n).toBe(2);
    expect(m.canUndo).toBe(false);
    expect(m.bounds()).toEqual({ min: { x: 2, y: 2, z: 2 }, max: { x: 2, y: 2, z: 2 } });
    expect(new VoxelModel().bounds()).toBeNull();
  });

  it("neighborCell follows the face normal and returns null off-grid", () => {
    expect(neighborCell({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
    expect(neighborCell({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBeNull();
    expect(neighborCell({ x: 15, y: 15, z: 15 }, { x: 0, y: 0, z: 1 })).toBeNull();
    expect(neighborCell({ x: 4, y: 4, z: 4 }, { x: 0.9999, y: 0, z: 0.0001 })).toEqual({ x: 5, y: 4, z: 4 });
    expect(inGrid({ x: 15, y: 15, z: 15 })).toBe(true);
    expect(inGrid({ x: 16, y: 0, z: 0 })).toBe(false);
  });
});
