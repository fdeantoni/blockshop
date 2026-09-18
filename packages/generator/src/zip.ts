import { zipSync, unzipSync, type Zippable } from "fflate";
import type { FileTree } from "./types.js";

/** Fixed timestamp so identical trees zip to identical bytes. */
export const ZIP_MTIME = new Date(2020, 0, 1, 0, 0, 0); // local-time constructor: same DOS timestamp in every timezone

export function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? new TextEncoder().encode(v) : v;
}

/** `.mcaddon` = zip whose root holds the two pack folders. */
export function zipMcaddon(tree: FileTree): Uint8Array {
  const entries: Zippable = {};
  for (const path of [...tree.keys()].sort()) entries[path] = [toBytes(tree.get(path)!), { mtime: ZIP_MTIME, level: 6 }];
  return zipSync(entries, { mtime: ZIP_MTIME });
}

/** Zip only the files under `prefix`, with the prefix stripped: a `.mcpack` holds one pack's files at its root. */
export function zipSubtree(tree: FileTree, prefix: string): Uint8Array {
  const sub: FileTree = new Map();
  for (const [k, v] of tree) if (k.startsWith(prefix)) sub.set(k.slice(prefix.length), v);
  if (sub.size === 0) throw new Error(`nothing under ${prefix}`);
  return zipMcaddon(sub);
}

export function listZip(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes)).sort();
}

/** A zip's files by path; for checking what was written. */
export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}
