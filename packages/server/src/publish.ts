import { join } from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import type { Version } from "@blockshop/schema";
import { buildPack, jsonText, previewTree, sanityCheck, writeTree, zipMcaddon, packFolderNames, type BuildReport } from "@blockshop/generator";
import type { Config } from "./config.js";
import { ProjectError, Store } from "./store.js";
import { runMct, type McToolsResult } from "./validate.js";

export interface PublishResult {
  version: Version;
  versionString: string;
  mcaddonFile: string;
  mcaddonUrl: string;
  pieceCount: number;
  cubeCount: number;
  warnings: string[];
  validation: McToolsResult | null;
  durationMs: number;
}

export interface LastReport {
  build: BuildReport;
  sanity: { errors: string[]; warnings: string[] };
  validation: McToolsResult | null;
  result: Omit<PublishResult, "validation"> | null;
  error: string | null;
  at: string;
}

export function mcaddonFileName(packName: string, version: Version): string {
  return `${packFolderNames({ packName }).bp.replace(/_bp$/, "")}-${version.join(".")}.mcaddon`;
}

/**
 * One profile's publish: the local-world Bedrock pack (.mcaddon), history and report. One at a time per
 * profile; a second call while one runs is refused with 409. The family server is a separate, grown-up
 * step (server-export.ts) that merges every profile's last published version.
 */
export class Publisher {
  private inFlight: Promise<unknown> | null = null;
  constructor(private readonly store: Store, private readonly config: Config, private readonly log: FastifyBaseLogger, private readonly packsUrl: string) {}

  get busy(): boolean { return this.inFlight !== null; }

  publish(): Promise<PublishResult> {
    if (this.inFlight) throw new ProjectError("a publish is already in progress", 409);
    const p = this.run().finally(() => { this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  private async run(): Promise<PublishResult> {
    const started = Date.now();
    const store = this.store;
    // 1. Bump and persist the version before generating so a failed publish never reuses one.
    const project = await store.withLock(async () => {
      const p = await store.getProject();
      p.version = [p.version[0], p.version[1], p.version[2] + 1];
      await store.saveProject(p);
      return p;
    });
    // Pieces nobody has drawn in yet are skipped, not fatal: a new empty piece must never block a publish.
    const allPieces = await store.listPieces();
    const pieces = allPieces.filter((p) => p.voxels.length > 0);
    const skipped = allPieces.length - pieces.length;
    const versionString = project.version.join(".");
    const log = this.log.child({ publish: versionString, namespace: project.namespace });
    const reportPath = join(store.distDir, "report.json");
    const writeReport = (r: LastReport) => writeFile(reportPath, jsonText(r));
    await mkdir(store.distDir, { recursive: true });

    try {
      if (pieces.length === 0) throw new ProjectError("nothing to publish: no pieces with voxels yet", 422);
      // 2. Build + own checks. Generator errors describe bad input, so they are 422s.
      let built;
      try {
        built = buildPack(project, pieces);
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
      await writeFile(join(store.packsDir, "latest.json"), jsonText({ version: project.version, file }));
      await store.saveHistory(project.version, mcaddonPath, { "report.json": jsonText(built.report) });

      const result: PublishResult = {
        version: project.version,
        versionString,
        mcaddonFile: file,
        mcaddonUrl: `${this.packsUrl}/${file}`,
        pieceCount: pieces.length,
        cubeCount: built.report.pieces.reduce((n, p) => n + p.cubesAfterMerge, 0),
        warnings: [...sanity.warnings, ...(validation?.warnings ?? [])],
        validation,
        durationMs: Date.now() - started,
      };
      const { validation: _v, ...rest } = result;
      await writeReport({ build: built.report, sanity, validation, result: rest, error: null, at: new Date().toISOString() });
      log.info({ pieces: result.pieceCount, skippedEmpty: skipped, cubes: result.cubeCount, warnings: result.warnings.length, validated: validation !== null, ms: result.durationMs }, "published");
      return result;
    } catch (e) {
      log.error({ err: e }, "publish failed");
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
