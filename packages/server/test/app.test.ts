import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listZip } from "@blockshop/generator";
import { MAX_PIECES_PER_PROFILE, MAX_PROFILES } from "@blockshop/schema";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const chair = async () => JSON.parse(await readFile(fixtures + "pieces/chair_asym.json", "utf8"));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function start(env: Record<string, string> = {}): Promise<AppContext & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "blockshop-app-"));
  const config = loadConfig({ DATA_DIR: dir, HOST_URL: "http://minecraft.local:8080", VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(dir, "no-editor"), ...env });
  const ctx = await buildApp(config);
  return { ...ctx, dir };
}

/** Setup + a kid profile, the way most tests start. Returns the admin token. */
async function setUp(ctx: AppContext, kid = "Chloë-Mae"): Promise<string> {
  const s = await ctx.app.inject({ method: "POST", url: "/api/setup", payload: { pin: "1234", name: "Dad", icon: "🧔" } });
  expect(s.statusCode, s.body).toBe(201);
  const token = s.json().token as string;
  const k = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: { "x-admin-token": token }, payload: { name: kid, icon: "🦄" } });
  expect(k.statusCode, k.body).toBe(201);
  return token;
}

describe("config", () => {
  it("defaults and validation", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.hostUrl).toBe("http://localhost:8080");
    expect(c.validate).toBe(true);
    expect(c.adminPin).toBeNull();
    expect(loadConfig({ HOST_URL: "http://minecraft.local:8080/", VALIDATE: "false", ADMIN_PIN: "2468" })).toMatchObject({ hostUrl: "http://minecraft.local:8080", validate: false, adminPin: "2468" });
    expect(() => loadConfig({ PORT: "abc" })).toThrow();
  });
});

describe("workspace and profiles", () => {
  let ctx: AppContext & { dir: string };
  let token: string;
  beforeAll(async () => { ctx = await start(); });
  afterAll(async () => { await ctx.app.close(); await rm(ctx.dir, { recursive: true, force: true }); });

  it("starts empty and asks for setup", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/workspace" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setupNeeded: true, profiles: [], maxProfiles: MAX_PROFILES, maxPieces: MAX_PIECES_PER_PROFILE });
    // The running version, for the footer: whatever this package says, never a failure to start.
    expect(res.json().version).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/api/setup", payload: { pin: "12", name: "Dad", icon: "🧔" } })).statusCode).toBe(400);
  });

  it("setup sets the PIN and creates the grown-up profile, once", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/setup", payload: { pin: "1234", name: "Dad", icon: "🧔" } });
    expect(res.statusCode, res.body).toBe(201);
    token = res.json().token;
    expect(res.json().profile).toMatchObject({ id: "dad", name: "Dad", icon: "🧔", role: "grownup", namespace: "dad", packName: "Dad's Furniture", versionString: "1.0.0", latest: null, pieceCount: 0, maxPieces: MAX_PIECES_PER_PROFILE });
    expect((await ctx.app.inject({ method: "POST", url: "/api/setup", payload: { pin: "9999", name: "X", icon: "x" } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "GET", url: "/api/workspace" })).json().setupNeeded).toBe(false);
    const project = JSON.parse(await readFile(join(ctx.dir, "profiles", "dad", "project.json"), "utf8"));
    expect(project.namespace).toBe("dad");
    expect(new Set(Object.values(project.uuids)).size).toBe(5);
    const ws = JSON.parse(await readFile(join(ctx.dir, "blockshop.json"), "utf8"));
    expect(ws.admin.pinHash).toBeDefined();
    expect(ws.admin.pinHash).not.toContain("1234");
  });

  it("the grown-up page needs the PIN session", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": "nope" } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { pin: "0000" } })).statusCode).toBe(401);
    const login = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { pin: "1234" } });
    expect(login.statusCode).toBe(200);
    const t2 = login.json().token;
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": t2 } })).json().profiles).toHaveLength(1);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/logout", headers: { "x-admin-token": t2 } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": t2 } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": token } })).statusCode).toBe(200);
  });

  it("adds kids and guests up to the profile cap, with ids derived from names", async () => {
    const auth = { "x-admin-token": token };
    const a = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth, payload: { name: "Chloë-Mae", icon: "🦄" } });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ id: "chloe_mae", role: "kid", packName: "Chloë-Mae's Furniture", namespace: "chloe_mae" });
    const b = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth, payload: { name: "Jules", icon: "🦊" } });
    expect(b.json()).toMatchObject({ id: "jules", packName: "Jules' Furniture" });
    // A guest: same packs and editor, but off the family server until a grown-up says otherwise.
    const g = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth, payload: { name: "Sam", icon: "🐸", role: "guest" } });
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json()).toMatchObject({ id: "sam", role: "guest", onFamilyServer: false });
    expect((await ctx.app.inject({ method: "PUT", url: "/api/admin/profiles/sam", headers: auth, payload: { onFamilyServer: true } })).json()).toMatchObject({ onFamilyServer: true });
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth, payload: { name: "Five", icon: "5" } })).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth, payload: { name: "Six", icon: "6" } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", payload: { name: "Nope", icon: "x" } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/workspace" })).json().profiles.map((p: { id: string }) => p.id)).toEqual(["dad", "chloe_mae", "jules", "sam", "five"]);
  });

  it("keeps pieces per profile with counter ids, up to the safety rail", async () => {
    const c1 = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: "Stoel", author: "Chloë" } });
    expect(c1.statusCode).toBe(201);
    expect(c1.json()).toMatchObject({ id: "piece_1", voxels: [] });
    expect((await ctx.app.inject({ method: "POST", url: "/api/profiles/dad/pieces", payload: {} })).json().id).toBe("piece_1"); // counters are per profile
    expect((await ctx.app.inject({ method: "POST", url: "/api/profiles/nope/pieces", payload: {} })).statusCode).toBe(404);
    for (let i = 2; i <= MAX_PIECES_PER_PROFILE; i++) expect((await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: `P${i}` } })).statusCode).toBe(201);
    const full = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: "One too many" } });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatch(/full/);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae" })).json().pieceCount).toBe(MAX_PIECES_PER_PROFILE);
    // A hidden piece still counts; one that is not on the family server can be deleted for real.
    await ctx.app.inject({ method: "POST", url: `/api/profiles/chloe_mae/pieces/piece_${MAX_PIECES_PER_PROFILE}/hide` });
    expect((await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: {} })).statusCode).toBe(409);
    for (let i = 3; i <= MAX_PIECES_PER_PROFILE; i++) expect((await ctx.app.inject({ method: "DELETE", url: `/api/profiles/chloe_mae/pieces/piece_${i}` })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces" })).json()).toHaveLength(2);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/profiles/chloe_mae/pieces/piece_3" })).statusCode).toBe(404);

    const fixture = await chair();
    const up = await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1", payload: { voxels: fixture.voxels, options: fixture.options } });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json().voxels).toHaveLength(fixture.voxels.length);
    await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_2", payload: { voxels: [{ x: 0, y: 0, z: 0, c: "stone" }] } });
    expect((await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_2", payload: { voxels: [{ x: 0, y: 0, z: 0, c: "nope" }] } })).statusCode).toBe(400);
    const hidden = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces/piece_2/hide" });
    expect(hidden.json().options.hidden).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces" })).json().find((p: { id: string }) => p.id === "piece_2").hidden).toBe(true);
  });

  it("stores and serves thumbnails per profile", async () => {
    const put = await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1/thumbnail", payload: { dataUrl: PNG } });
    expect(put.statusCode).toBe(204);
    const get = await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces/piece_1/thumbnail.png" });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces" })).json()[0].hasThumbnail).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces/piece_2/thumbnail.png" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/dad/pieces/piece_1/thumbnail.png" })).statusCode).toBe(404);
  });

  it("makes one profile's pack: mcaddon under /p/<id>/packs, history, report, marks pieces", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.versionString).toBe("1.0.1");
    expect(r.mcaddonUrl).toBe("http://minecraft.local:8080/p/chloe_mae/packs/chlo_mae_s_furniture-1.0.1.mcaddon");
    expect(r.pieceCount).toBe(2);
    expect(r.validation).toBeNull();

    const dl = await ctx.app.inject({ method: "GET", url: "/p/chloe_mae/packs/chlo_mae_s_furniture-1.0.1.mcaddon" });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/octet-stream");
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="chlo_mae_s_furniture-1.0.1.mcaddon"');
    const entries = listZip(new Uint8Array(dl.rawPayload));
    expect(entries).toContain("chlo_mae_s_furniture_bp/blocks/chloe_mae_piece_1.json");
    expect(entries).toContain("chlo_mae_s_furniture_bp/blocks/chloe_mae_piece_2.json"); // hidden pieces still ship
    expect(entries).toContain("chlo_mae_s_furniture_bp/scripts/main.js");
    expect((await ctx.app.inject({ method: "GET", url: "/p/chloe_mae/packs/../../blockshop.json" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/p/dad/packs/chlo_mae_s_furniture-1.0.1.mcaddon" })).statusCode).toBe(404);

    const latest = await ctx.app.inject({ method: "GET", url: "/p/chloe_mae/packs/latest.mcaddon" });
    expect(latest.statusCode).toBe(302);
    expect(latest.headers["location"]).toBe("/p/chloe_mae/packs/chlo_mae_s_furniture-1.0.1.mcaddon");
    expect((await ctx.app.inject({ method: "GET", url: "/p/dad/packs/latest.mcaddon" })).statusCode).toBe(404);

    const info = (await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae" })).json();
    expect(info.versionString).toBe("1.0.1");
    expect(info.latest).toEqual({ version: "1.0.1", mcaddonUrl: "http://minecraft.local:8080/p/chloe_mae/packs/chlo_mae_s_furniture-1.0.1.mcaddon" });
    expect((await ctx.app.inject({ method: "GET", url: "/api/workspace" })).json().profiles.find((p: { id: string }) => p.id === "chloe_mae").latest.version).toBe("1.0.1");

    const piece = (await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces/piece_1" })).json();
    expect(piece.publishedInVersion).toEqual([1, 0, 1]);
    // Being in a pack does not protect a piece; being on the family server does, because other people
    // have it placed in the shared world.
    expect((await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1", payload: { options: { onFamilyServer: true } } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/profiles/chloe_mae/pieces/piece_1" })).statusCode).toBe(409);
    await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1", payload: { options: { onFamilyServer: false } } });

    const history = (await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/history" })).json();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ version: "1.0.1", mcaddon: "chlo_mae_s_furniture-1.0.1.mcaddon" });
    expect((await readdir(join(ctx.dir, "profiles", "chloe_mae", "history", "1.0.1"))).sort()).toEqual(["chlo_mae_s_furniture-1.0.1.mcaddon", "pieces.json", "project.json", "report.json"]);

    const report = (await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/report" })).json();
    expect(report.error).toBeNull();
    expect(report.build.pieces).toHaveLength(2);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/dad/report" })).statusCode).toBe(404);
  });

  it("asking again without an edit hands back the same pack, without a new version", async () => {
    const again = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ versionString: "1.0.1", rebuilt: false });
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/history" })).json()).toHaveLength(1);
  });

  it("an empty piece changes nothing; a real edit makes the next pack", async () => {
    const empty = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: "Leeg" } });
    const emptyId = empty.json().id as string;
    const unchanged = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" });
    expect(unchanged.json()).toMatchObject({ versionString: "1.0.1", rebuilt: false });

    await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1", payload: { name: "Andere naam" } });
    const res = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ versionString: "1.0.2", rebuilt: true, pieceCount: 2 });
    expect((await ctx.app.inject({ method: "GET", url: `/api/profiles/chloe_mae/pieces/${emptyId}` })).json().publishedInVersion).toBeUndefined();
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/pieces/piece_1" })).json().publishedInVersion).toEqual([1, 0, 1]);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae/history" })).json().map((h: { version: string }) => h.version)).toEqual(["1.0.2", "1.0.1"]);
  });

  it("serializes pack builds per profile: a concurrent request gets 409", async () => {
    const [a, b] = await Promise.all([
      ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" }),
      ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it("lets a kid change their icon; names and removal are for the grown-up", async () => {
    const icon = await ctx.app.inject({ method: "PUT", url: "/api/profiles/jules/icon", payload: { icon: "🐼" } });
    expect(icon.statusCode).toBe(200);
    expect(icon.json().icon).toBe("🐼");
    expect((await ctx.app.inject({ method: "PUT", url: "/api/admin/profiles/jules", payload: { name: "Julian" } })).statusCode).toBe(401);
    const renamed = await ctx.app.inject({ method: "PUT", url: "/api/admin/profiles/jules", headers: { "x-admin-token": token }, payload: { name: "Julian" } });
    expect(renamed.json()).toMatchObject({ id: "jules", name: "Julian", packName: "Julian's Furniture", icon: "🐼" });
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/admin/profiles/jules" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/admin/profiles/jules", headers: { "x-admin-token": token } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/jules" })).statusCode).toBe(404);
    const admin = (await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": token } })).json();
    expect(admin.retired).toEqual(["jules"]);
    expect((await readdir(join(ctx.dir, "deleted"))).some((d) => d.startsWith("jules-"))).toBe(true);
    // A retired id never comes back: the family server keeps its Java states.
    const again = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: { "x-admin-token": token }, payload: { name: "Jules", icon: "🦊" } });
    expect(again.json().id).toBe("jules2");
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/admin/profiles/dad", headers: { "x-admin-token": token } })).statusCode).toBe(409);
  });

  it("changing the PIN logs every browser out and hands the caller a new session", async () => {
    const res = await ctx.app.inject({ method: "PUT", url: "/api/admin/pin", headers: { "x-admin-token": token }, payload: { pin: "4321" } });
    expect(res.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": token } })).statusCode).toBe(401);
    token = res.json().token;
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin", headers: { "x-admin-token": token } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { pin: "4321" } })).statusCode).toBe(200);
  });

  it("rejects unknown routes with JSON and serves an API hint at / without the editor", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/nope" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/" })).json().api).toBe("/api/workspace");
  });
});

describe("ADMIN_PIN recovery", () => {
  it("replaces the PIN at start without touching profiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blockshop-pin-"));
    const first = await buildApp(loadConfig({ DATA_DIR: dir, VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(dir, "none") }));
    await setUp(first);
    await first.app.close();
    const second = await buildApp(loadConfig({ DATA_DIR: dir, VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(dir, "none"), ADMIN_PIN: "8888" }));
    expect((await second.app.inject({ method: "POST", url: "/api/admin/login", payload: { pin: "1234" } })).statusCode).toBe(401);
    expect((await second.app.inject({ method: "POST", url: "/api/admin/login", payload: { pin: "8888" } })).statusCode).toBe(200);
    expect((await second.app.inject({ method: "GET", url: "/api/workspace" })).json().profiles.map((p: { id: string }) => p.id)).toEqual(["dad", "chloe_mae"]);
    await second.app.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("editor static serving", () => {
  it("serves index.html at / and for unknown GET paths, keeps API 404s as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blockshop-editor-"));
    const editorDir = join(dir, "editor");
    await mkdir(join(editorDir, "assets"), { recursive: true });
    await writeFile(join(editorDir, "assets", "x.json"), "{}");
    await writeFile(join(editorDir, "index.html"), "<!doctype html><title>Blockshop test</title>");
    const ctx = await start({ EDITOR_DIR: editorDir });
    expect((await ctx.app.inject({ method: "GET", url: "/" })).body).toContain("Blockshop test");
    expect((await ctx.app.inject({ method: "GET", url: "/assets/x.json" })).statusCode).toBe(200);
    const deep = await ctx.app.inject({ method: "GET", url: "/some/client/route" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("Blockshop test");
    const missingApi = await ctx.app.inject({ method: "GET", url: "/api/nope" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "not found" });
    expect((await ctx.app.inject({ method: "GET", url: "/p/nope/packs/x.mcaddon" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/api/workspace" })).statusCode).toBe(200);
    await ctx.app.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("pack failures", () => {
  it("refuses an empty profile with 422 but still consumed a version", async () => {
    const ctx = await start();
    await setUp(ctx);
    const res = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/no pieces with voxels/);
    expect((await ctx.app.inject({ method: "GET", url: "/api/profiles/chloe_mae" })).json().versionString).toBe("1.0.1");
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });

  it.skipIf(process.env["BLOCKSHOP_SKIP_MCT"] === "1")("runs mct when VALIDATE=1 and reports it", { timeout: 120000 }, async () => {
    const ctx = await start({ VALIDATE: "1" });
    await setUp(ctx);
    const fixture = await chair();
    await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: "Stoel", voxels: fixture.voxels, options: fixture.options } });
    const res = await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pack" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().validation.ok).toBe(true);
    expect(res.json().validation.errors).toEqual([]);
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });
});
