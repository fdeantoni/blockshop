import { PieceSchema, ProjectSchema, unknownPaletteIds, type PackUuids, type Piece, type Project, type Version } from "@blockshop/schema";
import { buildPack } from "./pack.js";
import type { FileTree } from "./types.js";
import { deriveUuid } from "./uuid.js";

/**
 * The live packs a device's own worlds read from their `development_*_packs` folders: one pack per profile,
 * exactly like that profile's own `.mcaddon` but with its own ids and a version that never moves. Minecraft
 * reads a development pack from disk every time a world loads instead of copying it in, so replacing the
 * folder is the whole update — no import, no version to activate (verified on an iPad, see format-notes.md).
 *
 * One pack per profile rather than one merged pack, so a kid can turn someone else's furniture off in their
 * own world.
 */

/** Folders inside the archive, one per destination, so a Shortcut saves each group in one action. */
export const DEV_ARCHIVE_DIRS = { bp: "behavior", rp: "resource" } as const;
export type DevPackKind = keyof typeof DEV_ARCHIVE_DIRS;

/**
 * Everyone's packs in one download; a device can never mix two builds. The hyphen keeps it out of reach of
 * `devArchiveName`, whose namespaces are `[a-z][a-z0-9_]*`: a profile called "Family" must not claim this name.
 */
export const DEV_ARCHIVE_ALL = "blockshop-all.zip";

/** One profile's packs: `blockshop_<namespace>.zip`. */
export function devArchiveName(namespace: string): string {
  return `blockshop_${namespace}.zip`;
}

/**
 * The folder that lands in Minecraft: `blockshop_<namespace>_bp` / `_rp`. This name is the contract with
 * every device — renaming it leaves a stale folder behind on all of them.
 */
export function devFolderName(namespace: string, kind: DevPackKind): string {
  return `blockshop_${namespace}_${kind}`;
}

/** Shown in the pack list, next to the profile's imported pack of the same name. */
export function devPackName(packName: string): string {
  return `${packName} (live)`.slice(0, 60);
}

/**
 * Derived from the profile's own pack ids, so they are stable without being stored, and never equal to the
 * imported pack's (the same ids twice would be one pack to Minecraft).
 */
export function devPackUuids(project: Pick<Project, "uuids">): PackUuids {
  const { uuids } = project;
  return {
    bp: deriveUuid(`blockshop:dev:bp:${uuids.bp}`),
    rp: deriveUuid(`blockshop:dev:rp:${uuids.rp}`),
    bpModule: deriveUuid(`blockshop:dev:bp-module:${uuids.bpModule}`),
    rpModule: deriveUuid(`blockshop:dev:rp-module:${uuids.rpModule}`),
    scriptModule: deriveUuid(`blockshop:dev:script:${uuids.scriptModule}`),
  };
}

/**
 * Never changes. A world refers to the pack by id and version; the contents move under it, which is the
 * point. A rising version would only bring back the "activate the new version" step this pack avoids.
 */
export const DEV_PACK_VERSION: Version = [1, 0, 0];

export interface DevProfileInput {
  project: Project;
  /** The pieces as they are saved right now; unpublished edits included. */
  pieces: readonly Piece[];
  /** The profile's icon as a PNG (the editor renders it), for the pack list. */
  packIcon?: Uint8Array | undefined;
}

export interface DevBuildInput { profiles: readonly DevProfileInput[] }

export interface DevProfileReport {
  namespace: string;
  packName: string;
  folders: Record<DevPackKind, string>;
  pieces: Array<{ id: string; identifier: string; name: string; cubes: number; seat: boolean; hidden: boolean }>;
  /** Pieces left out (no voxels yet, or a palette id the project no longer has). */
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
}

export interface DevBuildReport {
  version: Version;
  profiles: DevProfileReport[];
  fileCount: number;
}

export interface DevBuildResult { tree: FileTree; report: DevBuildReport }

/**
 * Pure: every profile's current pieces → one pack per profile, laid out as the archive a device downloads
 * (`behavior/blockshop_<ns>_bp/…`, `resource/blockshop_<ns>_rp/…`).
 *
 * Each pack comes from the same `buildPack` as the profile's `.mcaddon`, so block ids, geometry, seats and
 * the seat script are identical and furniture already placed in a world survives the switch. Only the ids,
 * the version and the pack name differ. A piece that cannot be built is skipped with a note rather than
 * throwing: this is built from whatever the editor has saved at that second, mid-edit included.
 */
export function buildDevPacks(input: DevBuildInput): DevBuildResult {
  const tree: FileTree = new Map();
  const profileReports: DevProfileReport[] = [];

  const profiles = input.profiles
    .map((p) => ({
      project: ProjectSchema.parse(p.project),
      pieces: p.pieces.map((x) => PieceSchema.parse(x)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      packIcon: p.packIcon,
    }))
    .sort((a, b) => (a.project.namespace < b.project.namespace ? -1 : a.project.namespace > b.project.namespace ? 1 : 0));

  const seen = new Set<string>();
  for (const { project } of profiles) {
    if (seen.has(project.namespace)) throw new Error(`duplicate namespace: ${project.namespace}`);
    seen.add(project.namespace);
  }

  for (const { project, pieces, packIcon } of profiles) {
    const ns = project.namespace;
    const skipped: DevProfileReport["skipped"] = [];
    const usable = pieces.filter((piece) => {
      if (piece.voxels.length === 0) { skipped.push({ id: piece.id, reason: "no voxels yet" }); return false; }
      const unknown = unknownPaletteIds(piece, project.palette);
      if (unknown.length) { skipped.push({ id: piece.id, reason: `unknown palette ids: ${unknown.join(", ")}` }); return false; }
      return true;
    });

    const devProject: Project = {
      ...project,
      packName: devPackName(project.packName),
      uuids: devPackUuids(project),
      version: DEV_PACK_VERSION,
    };
    const { tree: packTree, report } = buildPack(devProject, usable, { packIcon });

    // buildPack names its two folders after the pack; in the archive they carry the device-facing names.
    const folders = { bp: devFolderName(ns, "bp"), rp: devFolderName(ns, "rp") };
    for (const [path, content] of packTree) {
      const [packFolder, ...rest] = path.split("/");
      const kind: DevPackKind = packFolder!.endsWith("_bp") ? "bp" : "rp";
      tree.set(`${DEV_ARCHIVE_DIRS[kind]}/${folders[kind]}/${rest.join("/")}`, content);
    }

    profileReports.push({
      namespace: ns,
      packName: devProject.packName,
      folders,
      pieces: report.pieces.map((p) => ({ id: p.id, identifier: p.identifier, name: p.name, cubes: p.cubesAfterMerge, seat: p.seat, hidden: p.hidden })),
      skipped,
      warnings: report.warnings,
    });
  }

  return {
    tree: new Map([...tree.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    report: { version: DEV_PACK_VERSION, profiles: profileReports, fileCount: tree.size },
  };
}

/** The part of a built tree that belongs to one profile, for that profile's own archive. */
export function devProfileSubtree(tree: FileTree, namespace: string): FileTree {
  const out: FileTree = new Map();
  for (const kind of ["bp", "rp"] as const) {
    const prefix = `${DEV_ARCHIVE_DIRS[kind]}/${devFolderName(namespace, kind)}/`;
    for (const [path, content] of tree) if (path.startsWith(prefix)) out.set(path, content);
  }
  return out;
}
