import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listZip, readZip, devArchiveName, devFolderName, DEV_ARCHIVE_ALL, DEV_ARCHIVE_DIRS } from "@blockshop/generator";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const chair = async () => JSON.parse(await readFile(fixtures + "pieces/chair_asym.json", "utf8"));
const bpEntry = (ns: string, rest: string) => `${DEV_ARCHIVE_DIRS.bp}/${devFolderName(ns, "bp")}/${rest}`;
const rpEntry = (ns: string, rest: string) => `${DEV_ARCHIVE_DIRS.rp}/${devFolderName(ns, "rp")}/${rest}`;

describe("live packs for devices' own worlds", () => {
  let ctx: AppContext & { dir: string };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "blockshop-dev-"));
    ctx = { ...(await buildApp(loadConfig({ DATA_DIR: dir, HOST_URL: "http://minecraft.local:8080", VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(dir, "no-editor") }))), dir };
    const s = await ctx.app.inject({ method: "POST", url: "/api/setup", payload: { pin: "1234", name: "Dad", icon: "🧔" } });
    const token = s.json().token as string;
    const kid = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: { "x-admin-token": token }, payload: { name: "Robin", icon: "🦄" } });
    expect(kid.statusCode, kid.body).toBe(201);
    const piece = await chair();
    for (const pid of ["dad", "robin"]) {
      const r = await ctx.app.inject({ method: "POST", url: `/api/profiles/${pid}/pieces`, payload: { name: "Chair", voxels: piece.voxels, options: piece.options } });
      expect(r.statusCode, r.body).toBe(201);
    }
  });
  afterAll(async () => { await ctx.app.close(); await rm(ctx.dir, { recursive: true, force: true }); });

  it("one archive holds a pack per profile, sorted into the two destination folders", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain(DEV_ARCHIVE_ALL);
    const names = listZip(new Uint8Array(res.rawPayload));
    for (const ns of ["dad", "robin"]) {
      expect(names).toContain(bpEntry(ns, "manifest.json"));
      expect(names).toContain(bpEntry(ns, `blocks/${ns}_piece_1.json`));
      expect(names).toContain(rpEntry(ns, "manifest.json"));
    }
  });

  it("a profile's own archive holds only that profile, from the same build", async () => {
    const mine = await ctx.app.inject({ method: "GET", url: `/dev/${devArchiveName("robin")}` });
    expect(mine.statusCode, mine.body).toBe(200);
    const names = listZip(new Uint8Array(mine.rawPayload));
    expect(names.every((n) => n.includes("blockshop_robin_"))).toBe(true);
    expect(names).toContain(bpEntry("robin", "manifest.json"));

    const all = await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}` });
    const fromAll = readZip(new Uint8Array(all.rawPayload))[bpEntry("robin", "manifest.json")]!;
    const fromMine = readZip(new Uint8Array(mine.rawPayload))[bpEntry("robin", "manifest.json")]!;
    expect(new TextDecoder().decode(fromMine)).toBe(new TextDecoder().decode(fromAll));
  });

  it("each pack keeps one identity: live ids, version 1.0.0, unchanged across rebuilds and restarts", async () => {
    const manifestOf = async (app = ctx.app) => {
      const res = await app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}` });
      return JSON.parse(new TextDecoder().decode(readZip(new Uint8Array(res.rawPayload))[bpEntry("robin", "manifest.json")]!));
    };
    const first = await manifestOf();
    expect(first.header.name).toBe("Robin's Furniture (live)");
    expect(first.header.version).toEqual([1, 0, 0]);
    // Not the ids of the pack the profile publishes and imports.
    const own = (await ctx.app.inject({ method: "GET", url: "/api/profiles/robin" })).json() as { namespace: string };
    expect(own.namespace).toBe("robin");

    await ctx.app.inject({ method: "POST", url: "/api/profiles/robin/pieces", payload: { name: "Second", voxels: (await chair()).voxels } });
    expect((await manifestOf()).header.uuid).toBe(first.header.uuid);

    const again = await buildApp(loadConfig({ DATA_DIR: ctx.dir, VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(ctx.dir, "no-editor") }));
    expect((await manifestOf(again.app)).header.uuid).toBe(first.header.uuid);
    await again.app.close();
  });

  it("an edit changes the archive, and an unchanged one answers 304 for the same ETag", async () => {
    const first = await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}` });
    const etag = first.headers.etag as string;
    expect((await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}`, headers: { "if-none-match": etag } })).statusCode).toBe(304);

    const pieces = (await ctx.app.inject({ method: "GET", url: "/api/profiles/robin/pieces" })).json() as Array<{ id: string }>;
    await ctx.app.inject({ method: "PUT", url: `/api/profiles/robin/pieces/${pieces[0]!.id}`, payload: { name: "Renamed" } });
    const third = await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}`, headers: { "if-none-match": etag } });
    expect(third.statusCode).toBe(200);
    expect(third.headers.etag).not.toBe(etag);
  });

  it("/api/dev lists the archive, each profile's own, and what was skipped", async () => {
    const created = await ctx.app.inject({ method: "POST", url: "/api/profiles/dad/pieces", payload: { name: "Empty" } });
    const res = await ctx.app.inject({ method: "GET", url: "/api/dev" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      archive: { file: string; url: string };
      dirs: { bp: string; rp: string };
      profiles: Array<{ namespace: string; packName: string; folders: { bp: string; rp: string }; archive: { url: string }; pieces: unknown[]; skipped: Array<{ id: string; reason: string }> }>;
    };
    expect(body.archive.url).toBe(`http://minecraft.local:8080/dev/${DEV_ARCHIVE_ALL}`);
    expect(body.dirs).toEqual(DEV_ARCHIVE_DIRS);
    expect(body.profiles.map((p) => p.namespace)).toEqual(["dad", "robin"]);
    expect(body.profiles[0]!.folders).toEqual({ bp: "blockshop_dad_bp", rp: "blockshop_dad_rp" });
    expect(body.profiles[0]!.archive.url).toBe(`http://minecraft.local:8080/dev/${devArchiveName("dad")}`);
    expect(body.profiles[0]!.skipped).toEqual([{ id: created.json().id, reason: "no voxels yet" }]);
    // A piece being drawn right now must not break the download.
    expect((await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}` })).statusCode).toBe(200);
  });

  it("a profile's icon, once the editor has drawn it, is the icon on its packs", async () => {
    // A 1×1 PNG stands in for what the editor renders from the emoji or the custom icon.
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const bytes = Buffer.from(png.slice("data:image/png;base64,".length), "base64");
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/robin" })).json().hasIconPng).toBe(false);

    const put = await ctx.app.inject({ method: "PUT", url: "/api/profiles/robin/icon.png", payload: { dataUrl: png } });
    expect(put.statusCode, put.body).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/robin" })).json().hasIconPng).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/robin/icon.png" })).headers["content-type"]).toBe("image/png");

    const res = await ctx.app.inject({ method: "GET", url: `/dev/${DEV_ARCHIVE_ALL}` });
    const files = readZip(new Uint8Array(res.rawPayload));
    expect(Buffer.from(files[bpEntry("robin", "pack_icon.png")]!)).toEqual(bytes);
    expect(Buffer.from(files[rpEntry("robin", "pack_icon.png")]!)).toEqual(bytes);
    // Only that profile's packs: the others keep the generated icon.
    expect(Buffer.from(files[bpEntry("dad", "pack_icon.png")]!)).not.toEqual(bytes);
  });

  it("unknown or malformed names are refused", async () => {
    for (const url of ["/dev/blockshop_nobody.zip", "/dev/other.zip", "/dev/blockshop_family", `/dev/../${DEV_ARCHIVE_ALL}`]) {
      expect((await ctx.app.inject({ method: "GET", url })).statusCode, url).not.toBe(200);
    }
  });
});
