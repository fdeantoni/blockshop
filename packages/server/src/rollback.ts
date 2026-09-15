import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PieceSchema, ProjectSchema, type Piece, type Project } from "@blockshop/schema";
import { atomicWrite, Store } from "./store.js";

export interface RollbackResult { version: string; restoredPieces: number; parkedPieces: number; parkedDir: string | null; nextVersion: string }

/**
 * Restore pieces and palette/generator settings from history/<version>/, keeping the
 * pack version counter moving forward (Minecraft only accepts a higher version on
 * re-import). Current pieces missing from the snapshot are parked, not deleted.
 * A publish is needed afterwards to produce the restored pack under a new version.
 */
export async function rollback(store: Store, version: string): Promise<RollbackResult> {
  const dir = join(store.historyDir, version);
  let snapshotProject: Project;
  let snapshotPieces: Piece[];
  try {
    snapshotProject = ProjectSchema.parse(JSON.parse(await readFile(join(dir, "project.json"), "utf8")));
    snapshotPieces = (JSON.parse(await readFile(join(dir, "pieces.json"), "utf8")) as unknown[]).map((p) => PieceSchema.parse(p));
  } catch (e) {
    throw new Error(`no usable history for version ${version} in ${dir}: ${(e as Error).message}`);
  }
  return store.withLock(async () => {
    const current = await store.getProject();
    const restoredIds = new Set(snapshotPieces.map((p) => p.id));
    const existing = (await readdir(store.piecesDir)).filter((f) => f.endsWith(".json"));
    const toPark = existing.filter((f) => !restoredIds.has(f.replace(/\.json$/, "")));
    let parkedDir: string | null = null;
    if (toPark.length) {
      parkedDir = join(store.dataDir, `pieces-parked-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await mkdir(parkedDir, { recursive: true });
      for (const f of toPark) await rename(join(store.piecesDir, f), join(parkedDir, f));
    }
    for (const p of snapshotPieces) await atomicWrite(store.piecePath(p.id), JSON.stringify(p, null, 2) + "\n");
    // `java` (carrier states, cursor) stays the live one on purpose: those states are world state, never rewound.
    const project: Project = {
      ...current,
      palette: snapshotProject.palette,
      generator: snapshotProject.generator,
      packName: snapshotProject.packName,
      nextPieceNumber: Math.max(current.nextPieceNumber, snapshotProject.nextPieceNumber),
    };
    await store.saveProject(project);
    await rm(join(store.distDir, "report.json"), { force: true });
    return {
      version,
      restoredPieces: snapshotPieces.length,
      parkedPieces: toPark.length,
      parkedDir,
      nextVersion: [project.version[0], project.version[1], project.version[2] + 1].join("."),
    };
  });
}
