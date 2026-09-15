import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import type { FileTree } from "./types.js";

/** Write the tree under `dir` (which is removed first so stale files never linger). */
export async function writeTree(tree: FileTree, dir: string, opts: { clear?: boolean } = {}): Promise<void> {
  if (opts.clear !== false) await rm(dir, { recursive: true, force: true });
  for (const [rel, content] of tree) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** Flat copy of block geometries and palette textures, for dragging into Blockbench. */
export function previewTree(tree: FileTree): FileTree {
  const out: FileTree = new Map();
  for (const [rel, content] of tree) {
    if (rel.includes("/models/blocks/") || rel.includes("/textures/blocks/")) out.set(basename(rel), content);
  }
  return out;
}
