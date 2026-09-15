import { textureName } from "./block.js";
import type { Face, MeshBox } from "./types.js";

export interface JavaFace { uv: [number, number, number, number]; texture: string }
export interface JavaElement {
  from: [number, number, number];
  to: [number, number, number];
  faces: Partial<Record<Face, JavaFace>>;
}

/**
 * Editor box → Java block-model element. Java model space runs 0..16 on every axis with +x east
 * and +z south, which is the editor's own convention, so unlike Bedrock nothing is mirrored.
 */
export function toJavaElement(b: MeshBox): JavaElement {
  const el: JavaElement = { from: [b.x, b.y, b.z], to: [b.x + b.sx, b.y + b.sy, b.z + b.sz], faces: {} };
  for (const f of b.faces) {
    const dims: [number, number] =
      f === "up" || f === "down" ? [b.sx, b.sz] : f === "east" || f === "west" ? [b.sz, b.sy] : [b.sx, b.sy];
    el.faces[f] = { uv: [0, 0, dims[0], dims[1]], texture: `#${b.c}` };
  }
  return el;
}

/** `family:block/chair` → assets/family/models/block/chair.json */
export function javaModelPath(namespace: string, id: string): string {
  return `${namespace}:block/${id}`;
}

/** `family:block/family_oak` → assets/family/textures/block/family_oak.png */
export function javaTexturePath(namespace: string, paletteId: string): string {
  return `${namespace}:block/${textureName(namespace, paletteId)}`;
}

/** `parent: block/block` supplies the vanilla display transforms so the item renders in hand and in the inventory. */
export function buildJavaModel(namespace: string, boxes: readonly MeshBox[], usage: readonly [string, number][], dominant: string) {
  const textures: Record<string, string> = { particle: javaTexturePath(namespace, dominant) };
  for (const [id] of usage) textures[id] = javaTexturePath(namespace, id);
  return { parent: "minecraft:block/block", textures, elements: boxes.map(toJavaElement) };
}
