import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GRID, IconSchema, MAX_PIECES_PER_PROFILE, MAX_PROFILES, PieceOptionsSchema, PinSchema, ProfileIdSchema, ProfileRoleSchema, VoxelSchema, type Profile } from "@blockshop/schema";
import type { Config } from "./config.js";
import { devArchiveName, DEV_ARCHIVE_ALL, DEV_ARCHIVE_DIRS } from "@blockshop/generator";
import { DevPackServer } from "./dev-pack.js";
import { ProjectError, Store } from "./store.js";
import { PackBuilder, type LastReport } from "./pack.js";
import { ServerExporter } from "./server-export.js";
import { Workspace } from "./workspace.js";

const NameSchema = z.string().trim().min(1).max(40);
const PieceCreateSchema = z.object({
  name: NameSchema.optional(),
  author: z.string().max(40).optional(),
  voxels: z.array(VoxelSchema).max(GRID ** 3).optional(),
  options: PieceOptionsSchema.optional(),
});
const PieceUpdateSchema = PieceCreateSchema;
const ThumbnailSchema = z.object({ dataUrl: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(400_000) });
const IdParam = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/) });
const ProfileParam = z.object({ pid: ProfileIdSchema });
const ProfilePieceParam = ProfileParam.extend(IdParam.shape);
const FileParam = ProfileParam.extend({ file: z.string().regex(/^[a-z0-9_.-]+\.mcaddon$/) });
const DevFileParam = z.object({ file: z.string().regex(/^blockshop(-all|_[a-z][a-z0-9_]{0,15})\.zip$/) });
const SetupSchema = z.object({ pin: PinSchema, name: NameSchema, icon: IconSchema });
const LoginSchema = z.object({ pin: z.string().max(16) });
const PinChangeSchema = z.object({ pin: PinSchema });
const ProfileCreateSchema = z.object({ name: NameSchema, icon: IconSchema, role: ProfileRoleSchema.default("kid"), onFamilyServer: z.boolean().optional() });
const ProfilePatchSchema = z.object({ name: NameSchema.optional(), icon: IconSchema.optional(), onFamilyServer: z.boolean().optional() });
const IconPatchSchema = z.object({ icon: IconSchema });

export interface AppContext { app: FastifyInstance; workspace: Workspace; config: Config; packBuilderFor: (pid: string) => Promise<PackBuilder>; exporter: ServerExporter; devPacks: DevPackServer }

/** What the editor needs about one profile: identity, pack state and the palette. */
export interface ProfileInfo extends Profile {
  namespace: string; packName: string; version: number[]; versionString: string;
  palette: unknown; latest: { version: string; mcaddonUrl: string } | null;
  makingPack: boolean; pieceCount: number; maxPieces: number;
  /** Whether the editor has uploaded this profile's icon as a PNG for the packs to carry. */
  hasIconPng: boolean;
}

async function dirExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function buildApp(config: Config): Promise<AppContext> {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 2 * 1024 * 1024 });
  const workspace = new Workspace(config.dataDir);
  await workspace.init({ adminPin: config.adminPin });
  if (config.adminPin) app.log.warn("ADMIN_PIN is set: the grown-up PIN was replaced from the environment; remove the variable again");
  const builders = new Map<string, PackBuilder>();
  const packBuilderFor = async (pid: string): Promise<PackBuilder> => {
    const store = await workspace.storeFor(pid);
    let p = builders.get(pid);
    if (!p) { p = new PackBuilder(store, config, app.log, `${config.hostUrl}/p/${pid}/packs`); builders.set(pid, p); }
    return p;
  };
  const exporter = new ServerExporter(workspace, config, app.log, packBuilderFor);
  const devPacks = new DevPackServer(workspace, app.log);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ProjectError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid request", issues: err.issues });
    const e = err as Error & { statusCode?: number };
    app.log.error({ err: e }, "unhandled error");
    const status = e.statusCode ?? 500;
    return reply.status(status).send({ error: status === 500 ? "internal error" : e.message });
  });

  const tokenOf = (req: FastifyRequest): string | undefined =>
    (req.headers["x-admin-token"] as string | undefined) ?? (req.query as { token?: string }).token;
  const requireAdmin = async (req: FastifyRequest): Promise<string> => {
    const token = tokenOf(req);
    if (!(await workspace.hasSession(token))) throw new ProjectError("grown-up PIN needed", 401);
    return token!;
  };

  const latestOf = async (store: Store, pid: string): Promise<{ version: string; mcaddonUrl: string } | null> => {
    try {
      const l = JSON.parse(await readFile(join(store.packsDir, "latest.json"), "utf8")) as { version: number[]; file: string };
      return { version: l.version.join("."), mcaddonUrl: `${config.hostUrl}/p/${pid}/packs/${l.file}` };
    } catch { return null; }
  };
  const profileInfo = async (profile: Profile): Promise<ProfileInfo> => {
    const store = await workspace.storeFor(profile.id);
    const p = await store.getProject();
    return {
      ...profile,
      namespace: p.namespace, packName: p.packName, version: p.version, versionString: p.version.join("."),
      palette: p.palette, latest: await latestOf(store, profile.id),
      hasIconPng: (await store.readIconPng()) !== undefined,
      makingPack: builders.get(profile.id)?.busy ?? false,
      pieceCount: await store.countPieces(), maxPieces: MAX_PIECES_PER_PROFILE,
    };
  };

  // ---- Workspace: what every device sees first
  app.get("/api/workspace", async () => {
    const profiles = await workspace.listProfiles();
    return {
      uiTitle: config.uiTitle,
      setupNeeded: await workspace.setupNeeded(),
      maxProfiles: MAX_PROFILES,
      maxPieces: MAX_PIECES_PER_PROFILE,
      profiles: await Promise.all(profiles.map(profileInfo)),
    };
  });

  /** First run: the grown-up PIN and the grown-up's own profile, in one go. Refused once a PIN exists. */
  app.post("/api/setup", async (req, reply) => {
    const body = SetupSchema.parse(req.body ?? {});
    if (!(await workspace.setupNeeded())) throw new ProjectError("already set up: use the grown-up page", 409);
    const token = await workspace.setPin(body.pin);
    const profile = await workspace.createProfile({ name: body.name, icon: body.icon, role: "grownup" });
    return reply.status(201).send({ token, profile: await profileInfo(profile) });
  });

  // ---- Grown-up page (PIN session in the x-admin-token header)
  app.post("/api/admin/login", async (req) => {
    const { pin } = LoginSchema.parse(req.body ?? {});
    const token = await workspace.login(pin);
    if (!token) throw new ProjectError("wrong PIN", 401);
    return { token };
  });
  app.post("/api/admin/logout", async (req, reply) => {
    const token = tokenOf(req);
    if (token) await workspace.logout(token);
    return reply.status(204).send();
  });
  app.get("/api/admin", async (req) => {
    await requireAdmin(req);
    const ws = await workspace.get();
    return { profiles: await Promise.all(ws.profiles.map(profileInfo)), retired: ws.retired, maxProfiles: MAX_PROFILES };
  });
  app.put("/api/admin/pin", async (req) => {
    await requireAdmin(req);
    const { pin } = PinChangeSchema.parse(req.body ?? {});
    return { token: await workspace.setPin(pin) };
  });
  app.post("/api/admin/profiles", async (req, reply) => {
    await requireAdmin(req);
    const body = ProfileCreateSchema.parse(req.body ?? {});
    return reply.status(201).send(await profileInfo(await workspace.createProfile(body)));
  });
  app.put("/api/admin/profiles/:pid", async (req) => {
    await requireAdmin(req);
    const { pid } = ProfileParam.parse(req.params);
    return profileInfo(await workspace.updateProfile(pid, ProfilePatchSchema.parse(req.body ?? {})));
  });
  app.delete("/api/admin/profiles/:pid", async (req, reply) => {
    await requireAdmin(req);
    const { pid } = ProfileParam.parse(req.params);
    await workspace.deleteProfile(pid);
    builders.delete(pid);
    return reply.status(204).send();
  });

  // ---- The family server (docs/family-server-internals.md): status, one update button, "it was restarted"
  app.get("/api/admin/server", async (req) => { await requireAdmin(req); return exporter.status(); });
  app.post("/api/admin/server/update", async (req) => { await requireAdmin(req); return exporter.update(); });
  app.post("/api/admin/server/restarted", async (req) => { await requireAdmin(req); return exporter.markRestarted(); });

  // ---- One profile: its pack, pieces and thumbnails
  app.get("/api/profiles/:pid", async (req) => profileInfo(await workspace.getProfile(ProfileParam.parse(req.params).pid)));

  /** A kid may change their own icon; names are for the grown-up page. */
  app.put("/api/profiles/:pid/icon", async (req) => {
    const { pid } = ProfileParam.parse(req.params);
    const { icon } = IconPatchSchema.parse(req.body ?? {});
    return profileInfo(await workspace.updateProfile(pid, { icon }));
  });

  app.get("/api/profiles/:pid/pieces", async (req) => (await workspace.storeFor(ProfileParam.parse(req.params).pid)).listSummaries());

  app.get("/api/profiles/:pid/pieces/:id", async (req) => {
    const { pid, id } = ProfilePieceParam.parse(req.params);
    const piece = await (await workspace.storeFor(pid)).getPiece(id);
    if (!piece) throw new ProjectError(`no such piece: ${id}`, 404);
    return piece;
  });

  app.post("/api/profiles/:pid/pieces", async (req, reply) => {
    const { pid } = ProfileParam.parse(req.params);
    const body = PieceCreateSchema.parse(req.body ?? {});
    return reply.status(201).send(await (await workspace.storeFor(pid)).createPiece(body));
  });

  app.put("/api/profiles/:pid/pieces/:id", async (req) => {
    const { pid, id } = ProfilePieceParam.parse(req.params);
    return (await workspace.storeFor(pid)).updatePiece(id, PieceUpdateSchema.parse(req.body ?? {}));
  });

  /** Only for pieces that are not on the family server; those are hidden instead (see `deletePiece`). */
  app.delete("/api/profiles/:pid/pieces/:id", async (req, reply) => {
    const { pid, id } = ProfilePieceParam.parse(req.params);
    await (await workspace.storeFor(pid)).deletePiece(id);
    return reply.status(204).send();
  });

  app.post("/api/profiles/:pid/pieces/:id/hide", async (req) => { const { pid, id } = ProfilePieceParam.parse(req.params); return (await workspace.storeFor(pid)).setHidden(id, true); });
  app.post("/api/profiles/:pid/pieces/:id/unhide", async (req) => { const { pid, id } = ProfilePieceParam.parse(req.params); return (await workspace.storeFor(pid)).setHidden(id, false); });

  app.put("/api/profiles/:pid/pieces/:id/thumbnail", async (req, reply) => {
    const { pid, id } = ProfilePieceParam.parse(req.params);
    const { dataUrl } = ThumbnailSchema.parse(req.body);
    await (await workspace.storeFor(pid)).setThumbnail(id, Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
    return reply.status(204).send();
  });

  /**
   * The profile's icon as a PNG for the packs to carry: the editor draws it (it can render emoji and the
   * custom icons, the server cannot) whenever the icon changes, and once for profiles made before this.
   */
  app.put("/api/profiles/:pid/icon.png", async (req, reply) => {
    const { pid } = ProfileParam.parse(req.params);
    const { dataUrl } = ThumbnailSchema.parse(req.body);
    await (await workspace.storeFor(pid)).setIconPng(Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
    return reply.status(204).send();
  });

  app.get("/api/profiles/:pid/icon.png", async (req, reply) => {
    const { pid } = ProfileParam.parse(req.params);
    const png = await (await workspace.storeFor(pid)).readIconPng();
    if (!png) throw new ProjectError("no icon yet", 404);
    return reply.type("image/png").header("Cache-Control", "no-cache").send(Buffer.from(png));
  });

  app.get("/api/profiles/:pid/pieces/:id/thumbnail.png", async (req, reply) => {
    const { pid, id } = ProfilePieceParam.parse(req.params);
    try {
      const png = await readFile((await workspace.storeFor(pid)).thumbnailPath(id));
      return reply.type("image/png").header("Cache-Control", "no-cache").send(png);
    } catch (e) {
      if (e instanceof ProjectError) throw e;
      throw new ProjectError("no thumbnail", 404);
    }
  });

  /** The Download button: makes the pack file current (validating it) and hands back where to get it. */
  app.post("/api/profiles/:pid/pack", async (req) => (await packBuilderFor(ProfileParam.parse(req.params).pid)).ensure());
  app.get("/api/profiles/:pid/history", async (req) => (await workspace.storeFor(ProfileParam.parse(req.params).pid)).listHistory());
  app.get("/api/profiles/:pid/report", async (req) => {
    const store = await workspace.storeFor(ProfileParam.parse(req.params).pid);
    try {
      return JSON.parse(await readFile(join(store.distDir, "report.json"), "utf8")) as LastReport;
    } catch {
      throw new ProjectError("no report yet", 404);
    }
  });

  // ---- Pack downloads: /p/<profile>/packs/<file>.mcaddon (Safari's download manager hands the file to Minecraft)
  app.get("/p/:pid/packs/latest.mcaddon", async (req, reply) => {
    const { pid } = ProfileParam.parse(req.params);
    const store = await workspace.storeFor(pid);
    try {
      const l = JSON.parse(await readFile(join(store.packsDir, "latest.json"), "utf8")) as { file: string };
      return reply.redirect(`/p/${pid}/packs/${l.file}`, 302);
    } catch {
      throw new ProjectError("no pack made yet", 404);
    }
  });
  app.get("/p/:pid/packs/:file", async (req, reply) => {
    const { pid, file } = FileParam.parse(req.params);
    const path = join((await workspace.storeFor(pid)).packsDir, file);
    let size: number;
    try { size = (await stat(path)).size; } catch { throw new ProjectError("no such pack", 404); }
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${file}"`)
      .header("Content-Length", String(size))
      .header("Cache-Control", "no-cache")
      .send(createReadStream(path));
  });

  // ---- Live packs for devices' own worlds (docs/ipad-setup.md): a Shortcut downloads one archive on every
  // Minecraft launch and drops the pack folders inside it into Minecraft's development pack folders.
  app.get("/api/dev", async () => {
    const build = await devPacks.get();
    const url = (file: string) => `${config.hostUrl}/dev/${file}`;
    return {
      // Everything a device needs in one download; its inner folders say where each pack goes.
      archive: { file: DEV_ARCHIVE_ALL, url: url(DEV_ARCHIVE_ALL) },
      dirs: DEV_ARCHIVE_DIRS,
      profiles: build.report.profiles.map((p) => ({
        namespace: p.namespace,
        packName: p.packName,
        folders: p.folders,
        archive: { file: devArchiveName(p.namespace), url: url(devArchiveName(p.namespace)) },
        pieces: p.pieces.map((x) => ({ identifier: x.identifier, name: x.name })),
        skipped: p.skipped,
        warnings: p.warnings,
      })),
      builtAt: build.builtAt,
      hash: build.hash,
    };
  });

  app.get("/dev/:file", async (req, reply) => {
    const { file } = DevFileParam.parse(req.params);
    const { bytes, hash } = await devPacks.archive(file);
    const etag = `"${hash}-${file}"`;
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    const body = Buffer.from(bytes);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${file}"`)
      .header("Content-Length", String(body.byteLength))
      .header("ETag", etag)
      .header("Cache-Control", "no-cache")
      .send(body);
  });

  // Family-server export files (docs/family-server-internals.md), for the grown-up.
  await app.register(fastifyStatic, { root: workspace.serverJavaDir, prefix: "/java/", decorateReply: false, index: false, list: true });

  // ---- Editor SPA
  if (await dirExists(config.editorDir)) {
    await app.register(fastifyStatic, { root: config.editorDir, prefix: "/", decorateReply: true, index: ["index.html"] });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === "GET" && !/^\/(api|p|java|dev)\//.test(req.url)) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "not found" });
    });
  } else {
    app.get("/", async () => ({ name: "blockshop", note: "editor not built; run pnpm build", api: "/api/workspace" }));
  }

  return { app, workspace, config, packBuilderFor, exporter, devPacks };
}
