import { mkdir, readFile, readdir, rename, writeFile, stat, copyFile, rm, access } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import {
  MAX_PIECES_PER_PROFILE, PieceSchema, ProjectSchema, ensureDefaultPalette, newProject, unknownPaletteIds,
  type Piece, type PieceOptions, type Project, type ProjectInput, type Voxel, type Version,
} from "@blockshop/schema";

export interface PieceSummary {
  id: string; name: string; author: string; hidden: boolean; updatedAt: string; createdAt: string;
  voxelCount: number; hasThumbnail: boolean; publishedInVersion?: Version;
}

/** Fields a client may send; `undefined` means "leave as is". */
export interface PiecePatch {
  name?: string | undefined;
  author?: string | undefined;
  voxels?: Voxel[] | undefined;
  options?: PieceOptions | undefined;
}

export interface HistoryEntry { version: string; mcaddon: string | null; size: number; publishedAt: string }

/** Write to a temp file in the same directory, then rename: readers never see a torn file. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export class ProjectError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/** JSON files on disk under a profile's folder. One piece per file; project.json holds uuids, version, palette. */
export class Store {
  private lock: Promise<unknown> = Promise.resolve();
  constructor(public readonly dataDir: string, private readonly maxPieces: number = MAX_PIECES_PER_PROFILE) {}

  get projectPath() { return join(this.dataDir, "project.json"); }
  get piecesDir() { return join(this.dataDir, "pieces"); }
  get thumbsDir() { return join(this.dataDir, "thumbnails"); }
  get distDir() { return join(this.dataDir, "dist"); }
  get packsDir() { return join(this.distDir, "packs"); }
  get currentDir() { return join(this.distDir, "current"); }
  get previewDir() { return join(this.distDir, "preview"); }
  get mctReportDir() { return join(this.distDir, "mct-report"); }
  /** Last Java export (CraftEngine pack, Geyser mappings, served .mcpack); deployed from here. */
  get javaDir() { return join(this.distDir, "java"); }
  get historyDir() { return join(this.dataDir, "history"); }
  piecePath(id: string) { return join(this.piecesDir, `${id}.json`); }
  thumbnailPath(id: string) { return join(this.thumbsDir, `${id}.png`); }

  /** Serialize mutations that touch project.json (id minting, version bumps). */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** Create the folders and project.json (with `overrides`, e.g. namespace and pack name) when missing. */
  async init(overrides: Partial<ProjectInput> = {}): Promise<Project> {
    for (const d of [this.piecesDir, this.thumbsDir, this.packsDir, this.currentDir, this.previewDir, this.mctReportDir, this.javaDir, this.historyDir]) await mkdir(d, { recursive: true });
    try {
      const { project, added } = ensureDefaultPalette(await this.getProject());
      if (added.length) await this.saveProject(project);
      return project;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const project = newProject({ bp: randomUUID(), rp: randomUUID(), bpModule: randomUUID(), rpModule: randomUUID(), scriptModule: randomUUID() }, overrides);
      await this.saveProject(project);
      return project;
    }
  }

  async getProject(): Promise<Project> {
    return ProjectSchema.parse(JSON.parse(await readFile(this.projectPath, "utf8")));
  }

  async saveProject(project: Project): Promise<void> {
    await atomicWrite(this.projectPath, JSON.stringify(ProjectSchema.parse(project), null, 2) + "\n");
  }

  async listPieces(): Promise<Piece[]> {
    const files = (await readdir(this.piecesDir)).filter((f) => f.endsWith(".json")).sort();
    const pieces: Piece[] = [];
    for (const f of files) pieces.push(PieceSchema.parse(JSON.parse(await readFile(join(this.piecesDir, f), "utf8"))));
    return pieces;
  }

  async listSummaries(): Promise<PieceSummary[]> {
    const pieces = await this.listPieces();
    const out: PieceSummary[] = [];
    for (const p of pieces) {
      const s: PieceSummary = {
        id: p.id, name: p.name, author: p.author, hidden: p.options.hidden === true, updatedAt: p.updatedAt, createdAt: p.createdAt,
        voxelCount: p.voxels.length, hasThumbnail: await exists(this.thumbnailPath(p.id)),
      };
      if (p.publishedInVersion) s.publishedInVersion = p.publishedInVersion;
      out.push(s);
    }
    return out;
  }

  async getPiece(id: string): Promise<Piece | undefined> {
    try {
      return PieceSchema.parse(JSON.parse(await readFile(this.piecePath(id), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  private async savePiece(piece: Piece): Promise<void> {
    await atomicWrite(this.piecePath(piece.id), JSON.stringify(PieceSchema.parse(piece), null, 2) + "\n");
  }

  private async checkPalette(voxels: readonly Voxel[]): Promise<void> {
    const project = await this.getProject();
    const unknown = unknownPaletteIds({ voxels: [...voxels] }, project.palette);
    if (unknown.length) throw new ProjectError(`unknown palette ids: ${unknown.join(", ")}`);
  }

  async countPieces(): Promise<number> {
    return (await readdir(this.piecesDir)).filter((f) => f.endsWith(".json")).length;
  }

  /** Ids come from a counter in project.json, never from the editable name. Hidden pieces count against the cap. */
  async createPiece(input: PiecePatch): Promise<Piece> {
    if (input.voxels) await this.checkPalette(input.voxels);
    return this.withLock(async () => {
      if ((await this.countPieces()) >= this.maxPieces) throw new ProjectError(`this pack is full: ${this.maxPieces} pieces at most (hidden ones count; a hidden piece can be brought back and remade)`, 409);
      const project = await this.getProject();
      const n = project.nextPieceNumber;
      project.nextPieceNumber = n + 1;
      await this.saveProject(project);
      const now = new Date().toISOString();
      const piece = PieceSchema.parse({
        id: `piece_${n}`,
        name: input.name?.trim() || `Piece ${n}`,
        author: input.author ?? "",
        createdAt: now, updatedAt: now,
        voxels: input.voxels ?? [],
        options: input.options ?? {},
      });
      await this.savePiece(piece);
      return piece;
    });
  }

  async updatePiece(id: string, patch: PiecePatch): Promise<Piece> {
    const existing = await this.getPiece(id);
    if (!existing) throw new ProjectError(`no such piece: ${id}`, 404);
    if (patch.voxels) await this.checkPalette(patch.voxels);
    const piece: Piece = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
      ...(patch.author !== undefined ? { author: patch.author } : {}),
      ...(patch.voxels !== undefined ? { voxels: patch.voxels } : {}),
      ...(patch.options !== undefined ? { options: { ...existing.options, ...patch.options } } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.savePiece(piece);
    return piece;
  }

  async setHidden(id: string, hidden: boolean): Promise<Piece> {
    return this.updatePiece(id, { options: { hidden } });
  }

  /** Remove a piece for good. Only pieces that were never published: a published identifier must stay (placed blocks). */
  async deletePiece(id: string): Promise<void> {
    const piece = await this.getPiece(id);
    if (!piece) throw new ProjectError(`no such piece: ${id}`, 404);
    if (piece.publishedInVersion) throw new ProjectError(`${id} was published in v${piece.publishedInVersion.join(".")}: hide it instead`, 409);
    await rm(this.piecePath(id), { force: true });
    await rm(this.thumbnailPath(id), { force: true });
  }

  /** The profile's icon as a PNG, drawn by the editor (which can render emoji and the custom icons). */
  get iconPath() { return join(this.dataDir, "icon.png"); }

  async setIconPng(png: Uint8Array): Promise<void> {
    await atomicWrite(this.iconPath, png);
  }

  async readIconPng(): Promise<Uint8Array | undefined> {
    try { return new Uint8Array(await readFile(this.iconPath)); } catch { return undefined; }
  }

  async setThumbnail(id: string, png: Uint8Array): Promise<void> {
    if (!(await this.getPiece(id))) throw new ProjectError(`no such piece: ${id}`, 404);
    await atomicWrite(this.thumbnailPath(id), png);
  }

  /** Thumbnails that exist, keyed by piece id. */
  async readThumbnails(ids: readonly string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const id of ids) {
      try { out.set(id, new Uint8Array(await readFile(this.thumbnailPath(id)))); } catch { /* none yet */ }
    }
    return out;
  }

  /** Mark pieces as first published in `version` if they were not published before. */
  async markPublished(pieces: readonly Piece[], version: Version): Promise<void> {
    for (const p of pieces) {
      if (p.publishedInVersion) continue;
      await this.savePiece({ ...p, publishedInVersion: version });
    }
  }

  async saveHistory(version: Version, mcaddonPath: string | null, extras: Record<string, string | Uint8Array>): Promise<void> {
    const dir = join(this.historyDir, version.join("."));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await copyFile(this.projectPath, join(dir, "project.json"));
    if (mcaddonPath) await copyFile(mcaddonPath, join(dir, mcaddonPath.split("/").pop()!));
    for (const [name, content] of Object.entries(extras)) await writeFile(join(dir, name), content);
    const pieces = await this.listPieces();
    await writeFile(join(dir, "pieces.json"), JSON.stringify(pieces, null, 2) + "\n");
  }

  async listHistory(): Promise<HistoryEntry[]> {
    const dirs = (await readdir(this.historyDir).catch(() => [] as string[])).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
    const entries: HistoryEntry[] = [];
    for (const d of dirs) {
      const files = await readdir(join(this.historyDir, d));
      const mcaddon = files.find((f) => f.endsWith(".mcaddon")) ?? null;
      const st = await stat(join(this.historyDir, d, mcaddon ?? "project.json"));
      entries.push({ version: d, mcaddon, size: mcaddon ? st.size : 0, publishedAt: st.mtime.toISOString() });
    }
    return entries.sort((a, b) => compareVersions(b.version, a.version));
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
