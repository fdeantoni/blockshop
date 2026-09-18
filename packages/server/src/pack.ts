import { join } from "node:path";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import type { Piece, Project, Version } from "@blockshop/schema";
import { buildPack, jsonText, previewTree, sanityCheck, writeTree, zipMcaddon, packFolderNames, type BuildReport } from "@blockshop/generator";
import type { Config } from "./config.js";
import { ProjectError, Store } from "./store.js";
import { runMct, type McToolsResult } from "./validate.js";

export interface PackResult {
  version: Version;
  versionString: string;
  mcaddonFile: string;
  mcaddonUrl: string;
  pieceCount: number;
  cubeCount: number;
  warnings: string[];
  validation: McToolsResult | null;
  durationMs: number;
  /** false when the pieces had not changed since the last pack, so this is the same file again. */
  rebuilt: boolean;
}

/** `packs/latest.json`: which pack file is current, and what it was built from. */
export interface LatestPack {
  version: Version;
  file: string;
  /** Hash of the project and pieces the file was built from; absent in packs made before 0.4.0. */
  hash?: string;
}

export interface LastReport {
  build: BuildReport;
  sanity: { errors: string[]; warnings: string[] };
  validation: McToolsResult | null;
  result: Omit<PackResult, "validation"> | null;
  error: string | null;
  at: string;
}

export function mcaddonFileName(packName: string, version: Version): string {
  return `${packFolderNames({ packName }).bp.replace(/_bp$/, "")}-${version.join(".")}.mcaddon`;
}

/**
 * One profile's pack file: the `.mcaddon` for someone else's device, plus the version, history and report
 * that the family server and `pnpm rollback` rely on. Made on request (the Download button) and by the
 * family-server update, never on its own: a tablet with the Shortcut gets its furniture from the live
 * packs (docs/ipad-setup.md) and needs none of this.
 *
 * Unchanged pieces produce no work: the pack is rebuilt only when the project or the pieces differ from
 * what the current file was built from, so downloading twice hands over the same file and the same version.
 * One build at a time per profile; a second call while one runs is refused with 409.
 */
export class PackBuilder {
  private inFlight: Promise<PackResult> | null = null;
  constructor(private readonly store: Store, private readonly config: Config, private readonly log: FastifyBaseLogger, private readonly packsUrl: string) {}

  get busy(): boolean { return this.inFlight !== null; }

  /** The current pack, built if the pieces changed since the last one. */
  ensure(): Promise<PackResult> {
    if (this.inFlight) throw new ProjectError("a pack is already being made", 409);
    const p = this.run().finally(() => { this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  /** What the pieces hash to right now, and the pack file that matches it, if any. */
  private async current(): Promise<{ hash: string; latest: LatestPack | null; pieces: number }> {
    const project = await this.store.getProject();
    const pieces = (await this.store.listPieces()).filter((p) => p.voxels.length > 0);
    const hash = packInputHash(project, pieces, await this.store.readIconPng());
    let latest: LatestPack | null = null;
    try {
      latest = JSON.parse(await readFile(join(this.store.packsDir, "latest.json"), "utf8")) as LatestPack;
      await access(join(this.store.packsDir, latest.file));
    } catch { latest = null; }
    return { hash, latest, pieces: pieces.length };
  }

  private async run(): Promise<PackResult> {
    const started = Date.now();
    const unchanged = await this.current();
    if (unchanged.latest && unchanged.latest.hash === unchanged.hash) {
      const report = await readJson<LastReport>(join(this.store.distDir, "report.json"));
      return {
        version: unchanged.latest.version,
        versionString: unchanged.latest.version.join("."),
        mcaddonFile: unchanged.latest.file,
        mcaddonUrl: `${this.packsUrl}/${unchanged.latest.file}`,
        pieceCount: report?.result?.pieceCount ?? unchanged.pieces,
        cubeCount: report?.result?.cubeCount ?? 0,
        warnings: report?.result?.warnings ?? [],
        validation: report?.validation ?? null,
        durationMs: Date.now() - started,
        rebuilt: false,
      };
    }
    return this.build(unchanged.hash, started);
  }

  private async build(hash: string, started: number): Promise<PackResult> {
    const store = this.store;
    // 1. Bump and persist the version before generating so a failed build never reuses one.
    const project = await store.withLock(async () => {
      const p = await store.getProject();
      p.version = [p.version[0], p.version[1], p.version[2] + 1];
      await store.saveProject(p);
      return p;
    });
    // Pieces nobody has drawn in yet are skipped, not fatal: a new empty piece must never block a build.
    const allPieces = await store.listPieces();
    const pieces = allPieces.filter((p) => p.voxels.length > 0);
    const skipped = allPieces.length - pieces.length;
    const versionString = project.version.join(".");
    const log = this.log.child({ pack: versionString, namespace: project.namespace });
    const reportPath = join(store.distDir, "report.json");
    const writeReport = (r: LastReport) => writeFile(reportPath, jsonText(r));
    await mkdir(store.distDir, { recursive: true });

    try {
      if (pieces.length === 0) throw new ProjectError("nothing to put in a pack: no pieces with voxels yet", 422);
      // 2. Build + own checks. Generator errors describe bad input, so they are 422s.
      let built;
      try {
        built = buildPack(project, pieces, { packIcon: await store.readIconPng() });
      } catch (e) {
        throw new ProjectError(`pack generation failed: ${e instanceof Error ? e.message : String(e)}`, 422);
      }
      const sanity = sanityCheck(project, pieces, built);
      if (sanity.errors.length) {
        await writeReport({ build: built.report, sanity, validation: null, result: null, error: sanity.errors.join("; "), at: new Date().toISOString() });
        throw new ProjectError(`pack failed sanity checks: ${sanity.errors.join("; ")}`, 422);
      }
      await writeTree(built.tree, store.currentDir);
      await writeTree(previewTree(built.tree), store.previewDir);

      // 3. External validation.
      let validation: McToolsResult | null = null;
      if (this.config.validate) {
        validation = await runMct(store.currentDir, store.mctReportDir, { suite: this.config.mctSuite });
        if (!validation.ok) {
          await writeReport({ build: built.report, sanity, validation, result: null, error: validation.errors.join("; "), at: new Date().toISOString() });
          throw new ProjectError(`mct validation failed: ${validation.errors.join("; ")}`, 422);
        }
      }

      // 4. Zip, history, bookkeeping.
      const file = mcaddonFileName(project.packName, project.version);
      const mcaddonPath = join(store.packsDir, file);
      await mkdir(store.packsDir, { recursive: true });
      await writeFile(mcaddonPath, zipMcaddon(built.tree));
      await store.markPublished(pieces, project.version);
      const latest: LatestPack = { version: project.version, file, hash };
      await writeFile(join(store.packsDir, "latest.json"), jsonText(latest));
      await store.saveHistory(project.version, mcaddonPath, { "report.json": jsonText(built.report) });

      const result: PackResult = {
        version: project.version,
        versionString,
        mcaddonFile: file,
        mcaddonUrl: `${this.packsUrl}/${file}`,
        pieceCount: pieces.length,
        cubeCount: built.report.pieces.reduce((n, p) => n + p.cubesAfterMerge, 0),
        warnings: [...sanity.warnings, ...(validation?.warnings ?? [])],
        validation,
        durationMs: Date.now() - started,
        rebuilt: true,
      };
      const { validation: _v, ...rest } = result;
      await writeReport({ build: built.report, sanity, validation, result: rest, error: null, at: new Date().toISOString() });
      log.info({ pieces: result.pieceCount, skippedEmpty: skipped, cubes: result.cubeCount, warnings: result.warnings.length, validated: validation !== null, ms: result.durationMs }, "pack built");
      return result;
    } catch (e) {
      log.error({ err: e }, "pack build failed");
      if (!(e instanceof ProjectError)) {
        await writeReport({ build: { version: project.version, packName: project.packName, seatsEnabled: false, pieces: [], warnings: [], fileCount: 0 }, sanity: { errors: [], warnings: [] }, validation: null, result: null, error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() }).catch(() => undefined);
      }
      throw e;
    }
  }
}

export async function copyLatestTo(store: Store, target: string): Promise<void> {
  await copyFile(join(store.packsDir, "latest.json"), target);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

/**
 * What a pack is built from, as one string. Bookkeeping that never reaches the pack is left out, or a
 * build would always look like a change: the version rises with each build, `publishedInVersion` is
 * stamped on the pieces by the build that included them, and `nextPieceNumber` moves whenever a kid
 * starts a piece. `options.onFamilyServer` goes too (a pack file holds every piece whatever that says, and the
 * family server hashes the list it actually builds from), and so does `updatedAt`, which moves when a piece is
 * touched without its contents changing. Empty pieces never reach a pack either.
 */
export function packInputHash(project: Project, pieces: readonly Piece[], packIcon?: Uint8Array | undefined): string {
  const { version: _v, nextPieceNumber: _n, ...rest } = project;
  const input = {
    project: rest,
    // By id, so the order a caller happens to pass them in never counts as a change.
    pieces: [...pieces].filter((p) => p.voxels.length > 0).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ publishedInVersion: _p, updatedAt: _u, options, ...piece }) => {
        const { onFamilyServer: _s, ...rest } = options;
        return { ...piece, options: rest };
      }),
  };
  const h = createHash("sha256").update(JSON.stringify(input));
  if (packIcon) h.update(packIcon);
  return h.digest("hex").slice(0, 32);
}
