/**
 * DOM-free voxel model for the editor: placement, removal, undo/redo, mirror,
 * and the editor→scene coordinate convention. No three.js imports here so it
 * can be unit-tested in Node.
 */
import { GRID, sortVoxels, voxelKey, parseVoxelKey, type Voxel } from "@blockshop/schema";

export type Cell = { x: number; y: number; z: number };

/**
 * COORDINATE CONVENTION (single owner): editor voxel (x,y,z) is rendered with its
 * centre at three.js position (x+0.5, y+0.5, z+0.5). y is up, +x is east, +z is south,
 * identical to the generator, so the "front" view has the camera on +z looking toward -z.
 * Nothing in the editor mirrors or rotates; fixes after the device test go in
 * project.generator.mirrorX / rotationOffset only.
 */
export const CELL_CENTER_OFFSET = 0.5;

export function inGrid(c: Cell): boolean {
  return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < GRID && c.y < GRID && c.z < GRID;
}

/** Cell adjacent to `hit` in the direction of a unit face normal, or null when off-grid. */
export function neighborCell(hit: Cell, normal: { x: number; y: number; z: number }): Cell | null {
  const c = { x: hit.x + Math.round(normal.x), y: hit.y + Math.round(normal.y), z: hit.z + Math.round(normal.z) };
  return inGrid(c) ? c : null;
}

type Change = { key: string; before: string | undefined; after: string | undefined };

export class VoxelModel {
  private cells = new Map<string, string>();
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private listeners = new Set<() => void>();

  static fromVoxels(voxels: readonly Voxel[]): VoxelModel {
    const m = new VoxelModel();
    for (const v of voxels) m.cells.set(voxelKey(v.x, v.y, v.z), v.c);
    return m;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const fn of this.listeners) fn(); }

  get size(): number { return this.cells.size; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  get(c: Cell): string | undefined { return this.cells.get(voxelKey(c.x, c.y, c.z)); }
  has(c: Cell): boolean { return this.cells.has(voxelKey(c.x, c.y, c.z)); }

  /** Iterate cells with their palette id. */
  *entries(): IterableIterator<[Cell, string]> {
    for (const [k, c] of this.cells) {
      const [x, y, z] = parseVoxelKey(k);
      yield [{ x, y, z }, c];
    }
  }

  toVoxels(): Voxel[] {
    return sortVoxels([...this.entries()].map(([c, color]) => ({ ...c, c: color })));
  }

  /** Apply a batch of cell writes as one undo step. Returns false if nothing changed. */
  apply(writes: Array<{ cell: Cell; color: string | undefined }>): boolean {
    const changes: Change[] = [];
    for (const { cell, color } of writes) {
      if (!inGrid(cell)) continue;
      const key = voxelKey(cell.x, cell.y, cell.z);
      const before = this.cells.get(key);
      if (before === color) continue;
      if (color === undefined) this.cells.delete(key); else this.cells.set(key, color);
      changes.push({ key, before, after: color });
    }
    if (changes.length === 0) return false;
    this.undoStack.push(changes);
    this.redoStack = [];
    this.emit();
    return true;
  }

  place(cell: Cell, color: string): boolean { return this.apply([{ cell, color }]); }
  remove(cell: Cell): boolean { return this.apply([{ cell, color: undefined }]); }

  undo(): boolean {
    const changes = this.undoStack.pop();
    if (!changes) return false;
    for (const ch of [...changes].reverse()) { if (ch.before === undefined) this.cells.delete(ch.key); else this.cells.set(ch.key, ch.before); }
    this.redoStack.push(changes);
    this.emit();
    return true;
  }

  redo(): boolean {
    const changes = this.redoStack.pop();
    if (!changes) return false;
    for (const ch of changes) { if (ch.after === undefined) this.cells.delete(ch.key); else this.cells.set(ch.key, ch.after); }
    this.undoStack.push(changes);
    this.emit();
    return true;
  }

  /** Mirror the whole piece across the x centre of the grid (one undo step). */
  mirrorX(): boolean {
    const writes: Array<{ cell: Cell; color: string | undefined }> = [];
    const mirrored = new Map<string, string>();
    for (const [c, color] of this.entries()) mirrored.set(voxelKey(GRID - 1 - c.x, c.y, c.z), color);
    for (const [k] of this.cells) if (!mirrored.has(k)) { const [x, y, z] = parseVoxelKey(k); writes.push({ cell: { x, y, z }, color: undefined }); }
    for (const [k, color] of mirrored) { const [x, y, z] = parseVoxelKey(k); writes.push({ cell: { x, y, z }, color }); }
    return this.apply(writes);
  }

  /** Replace all content without touching history (used when loading a piece). */
  reset(voxels: readonly Voxel[]): void {
    this.cells = new Map(voxels.map((v) => [voxelKey(v.x, v.y, v.z), v.c]));
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  bounds(): { min: Cell; max: Cell } | null {
    if (this.cells.size === 0) return null;
    const min = { x: GRID, y: GRID, z: GRID }, max = { x: -1, y: -1, z: -1 };
    for (const [c] of this.entries()) {
      min.x = Math.min(min.x, c.x); min.y = Math.min(min.y, c.y); min.z = Math.min(min.z, c.z);
      max.x = Math.max(max.x, c.x); max.y = Math.max(max.y, c.y); max.z = Math.max(max.z, c.z);
    }
    return { min, max };
  }
}
