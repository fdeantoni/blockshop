import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  buildDevPacks, devArchiveName, devProfileSubtree, zipMcaddon,
  DEV_ARCHIVE_ALL, type DevBuildReport, type DevProfileInput,
} from "@blockshop/generator";
import { ProjectError } from "./store.js";
import type { Workspace } from "./workspace.js";

export interface DevPackBuild {
  /** Archive file name → bytes: everyone's packs, and one archive per profile. */
  archives: Map<string, Uint8Array>;
  /** Hash of everything the build was made from; also the ETag. */
  hash: string;
  report: DevBuildReport;
  builtAt: string;
}

/**
 * The live packs a device's own worlds read from their `development_*_packs` folders, built from the pieces
 * as they are saved right now (no publish step): a kid edits, opens Minecraft, and the Shortcut has already
 * replaced the folders. Rebuilt only when something changed, since every app launch on every device asks.
 *
 * One archive holds every pack a device needs, so its download can never mix a behaviour pack from one build
 * with a resource pack from another — two requests could straddle another child's edit. Each profile is its
 * own pack inside the archive, so a kid can turn someone else's furniture off in their own world.
 */
export class DevPackServer {
  private cache: DevPackBuild | null = null;
  private inFlight: Promise<DevPackBuild> | null = null;
  constructor(private readonly workspace: Workspace, private readonly log: FastifyBaseLogger) {}

  private async collect(): Promise<DevProfileInput[]> {
    const profiles: DevProfileInput[] = [];
    for (const p of await this.workspace.listProfiles()) {
      const store = await this.workspace.storeFor(p.id);
      profiles.push({ project: await store.getProject(), pieces: await store.listPieces(), packIcon: await store.readIconPng() });
    }
    return profiles;
  }

  async get(): Promise<DevPackBuild> {
    if (this.inFlight) return this.inFlight;
    const run = (async () => {
      const profiles = await this.collect();
      const hash = hashOf(profiles);
      if (this.cache?.hash === hash) return this.cache;
      const { tree, report } = buildDevPacks({ profiles });
      const archives = new Map<string, Uint8Array>([[DEV_ARCHIVE_ALL, zipMcaddon(tree)]]);
      for (const p of report.profiles) archives.set(devArchiveName(p.namespace), zipMcaddon(devProfileSubtree(tree, p.namespace)));
      const build: DevPackBuild = { archives, hash, report, builtAt: new Date().toISOString() };
      this.log.info(
        { profiles: report.profiles.length, pieces: report.profiles.reduce((n, p) => n + p.pieces.length, 0), hash: hash.slice(0, 8) },
        "live packs built",
      );
      for (const p of report.profiles) {
        for (const s of p.skipped) this.log.warn(`live pack: skipped ${p.namespace}:${s.id} (${s.reason})`);
        for (const w of p.warnings) this.log.warn(`live pack: ${p.namespace}: ${w}`);
      }
      this.cache = build;
      return build;
    })();
    this.inFlight = run;
    try { return await run; } finally { this.inFlight = null; }
  }

  /** One archive's bytes; 404 for a name no current profile has. */
  async archive(file: string): Promise<{ bytes: Uint8Array; hash: string }> {
    const build = await this.get();
    const bytes = build.archives.get(file);
    if (!bytes) throw new ProjectError(`no such live pack: ${file}`, 404);
    return { bytes, hash: build.hash };
  }
}

function hashOf(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
}
