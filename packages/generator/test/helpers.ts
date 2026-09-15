import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PieceSchema, ProjectSchema, type Piece, type Project } from "@blockshop/schema";

export const fixturesDir = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const project = (): Project => ProjectSchema.parse(JSON.parse(readFileSync(fixturesDir + "project.json", "utf8")));
export const piece = (id: string): Piece => PieceSchema.parse(JSON.parse(readFileSync(`${fixturesDir}pieces/${id}.json`, "utf8")));
export const fixtureIds = (): string[] => readdirSync(fixturesDir + "pieces").filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();

/** Small deterministic PRNG for randomized invariants. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
