import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JavaStatesSchema, PieceSchema, ProjectSchema, serverStateKey } from "@blockshop/schema";
import { allocateServerStates, buildServerPack, listZip } from "@blockshop/generator";
import { buildApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { deployJava, markRestarted, refreshDeployState, waitForRcon, writeJavaDist } from "../src/java-deploy.js";
import { parsePlayerList, stripColors } from "../src/java-players.js";
import { startFakeRcon } from "./fake-rcon.js";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const exists = (p: string) => access(p).then(() => true, () => false);
const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return silentLog; }, level: "silent" } as unknown as import("fastify").FastifyBaseLogger;
const fixture = async (id: string) => PieceSchema.parse(JSON.parse(await readFile(join(fixtures, "pieces", `${id}.json`), "utf8")));

/** The fixture project as one profile ("family"), every fixture piece, states allocated in memory. */
async function fixtureBuild() {
  const project = ProjectSchema.parse(JSON.parse(await readFile(fixtures + "project.json", "utf8")));
  const ids = (await readdir(fixtures + "pieces")).filter((f) => f.endsWith(".json"));
  const pieces = [];
  for (const f of ids) pieces.push(PieceSchema.parse(JSON.parse(await readFile(join(fixtures, "pieces", f), "utf8"))));
  const { states } = allocateServerStates(JavaStatesSchema.parse({}), pieces.map((p) => serverStateKey(project.namespace, p.id)));
  return buildServerPack({ version: [1, 0, 1], states, profiles: [{ project, pieces }] });
}

describe("java config", () => {
  it("defaults to off; on (or the older manual/publish) needs the directories", () => {
    expect(loadConfig({}).java).toMatchObject({ mode: "off", craftEngineDir: null, geyserDir: null, pluginsDir: null, rcon: null, commands: ["ce reload all", "geyser reload"], restartCommand: null });
    expect(loadConfig({}).java.catalogJar).toMatch(/plugin\/target\/BlockshopCatalog\.jar$/);
    expect(() => loadConfig({ JAVA_DEPLOY: "sometimes" })).toThrow(/JAVA_DEPLOY/);
    expect(() => loadConfig({ JAVA_DEPLOY: "on" })).toThrow(/CRAFTENGINE_DIR/);
    const c = loadConfig({ JAVA_DEPLOY: "manual", CRAFTENGINE_DIR: "/srv/mc/plugins/CraftEngine", GEYSER_DIR: "/srv/mc/plugins/Geyser-Spigot", PLUGINS_DIR: "/srv/mc/plugins", RCON_PASSWORD: "pw", JAVA_RCON_COMMANDS: "ce reload all; say hello", JAVA_RESTART_COMMAND: "systemctl restart paper" });
    expect(c.java).toMatchObject({ mode: "on", pluginsDir: "/srv/mc/plugins", rcon: { host: "127.0.0.1", port: 25575, password: "pw", timeoutMs: 120_000 }, commands: ["ce reload all", "say hello"], restartCommand: "systemctl restart paper" });
    expect(loadConfig({ JAVA_DEPLOY: "publish", CRAFTENGINE_DIR: "/a", GEYSER_DIR: "/b" }).java.mode).toBe("on");
    expect(() => loadConfig({ JAVA_RESTART_WAIT_MS: "soon" })).toThrow(/JAVA_RESTART_WAIT_MS/);
    expect(() => loadConfig({ RCON_PASSWORD: "pw", RCON_TIMEOUT_MS: "0" })).toThrow(/RCON_TIMEOUT_MS/);
    expect(() => loadConfig({ RCON_PASSWORD: "pw", RCON_PORT: "x" })).toThrow(/RCON_PORT/);
  });

  it("reads the player list, Floodgate names included, colour codes stripped", () => {
    expect(parsePlayerList("There are 2 of a max of 20 players online: Steve, .Alex")).toEqual(["Steve", ".Alex"]);
    expect(parsePlayerList("§eThere are 0 of a max of 20 players online:")).toEqual([]);
    expect(parsePlayerList("garbage")).toEqual([]);
    expect(stripColors("§7Gave §f1\x1b[37m item")).toBe("Gave 1 item");
  });
});

describe("deployJava", () => {
  let dir: string;
  let dist: string;
  let ce: string;
  let geyser: string;
  const base = { mode: "on" as const, rcon: null, commands: [] as string[], restartCommand: null, mcLogFile: null, restartWaitMs: 2000, pluginsDir: null, catalogJar: "/nonexistent.jar" };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "blockshop-java-"));
    dist = join(dir, "dist-java"); ce = join(dir, "plugins", "CraftEngine"); geyser = join(dir, "plugins", "Geyser-Spigot");
    await writeJavaDist(dist, await fixtureBuild(), "1.0.1", { family: "1.0.7" });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes the dist layout with one mcpack per profile and the report", async () => {
    expect(await exists(join(dist, "craftengine", "pack.yml"))).toBe(true);
    expect(await exists(join(dist, "geyser", "custom_mappings", "blockshop_blocks.json"))).toBe(true);
    expect((await readdir(join(dist, "geyser", "packs"))).sort()).toEqual(["blockshop_family.mcpack"]);
    expect(listZip(await readFile(join(dist, "geyser", "packs", "blockshop_family.mcpack")))).toContain("manifest.json");
    expect(JSON.parse(await readFile(join(dist, "build.json"), "utf8"))).toMatchObject({ version: "1.0.1", pieces: 5, profiles: { family: "1.0.7" } });
  });

  it("replaces the CraftEngine pack folder, syncs Geyser files and drops stale packs, reports a needed restart, then sees no change", async () => {
    const cfg = { ...base, craftEngineDir: ce, geyserDir: geyser, commands: ["ce reload all"] };
    await mkdir(join(ce, "resources", "blockshop", "configuration"), { recursive: true });
    await writeFile(join(ce, "resources", "blockshop", "configuration", "stale.yml"), "old: true\n");
    await mkdir(join(geyser, "packs"), { recursive: true });
    await writeFile(join(geyser, "packs", "blockshop-1.0.0.mcpack"), "old");
    await writeFile(join(geyser, "packs", "blockshop.mcpack"), "older layout");
    await writeFile(join(geyser, "packs", "somebody-else.mcpack"), "not ours");

    const first = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(first).toMatchObject({ version: "1.0.1", geyserChanged: true, mappingsChanged: true, packChanged: true, restarted: false, reloadedGeyser: false, restartNeeded: true, error: null, commands: [] });
    expect(await exists(join(ce, "resources", "blockshop", "configuration", "stale.yml"))).toBe(false);
    expect(await exists(join(ce, "resources", "blockshop", "configuration", "blockshop.json"))).toBe(true);
    expect(await exists(join(ce, "resources", "blockshop", "resourcepack", "assets", "family", "models", "block", "chair_asym.json"))).toBe(true);
    expect((await readdir(join(geyser, "packs"))).sort()).toEqual(["blockshop_family.mcpack", "somebody-else.mcpack"]);
    expect(await exists(join(geyser, "custom_mappings", "blockshop_items.json"))).toBe(true);
    expect((await readdir(join(ce, "resources"))).filter((f) => f.includes(".new-"))).toEqual([]);
    expect(JSON.parse(await readFile(join(dist, "deploy.json"), "utf8")).version).toBe("1.0.1");

    const second = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(second).toMatchObject({ geyserChanged: false, mappingsChanged: false, packChanged: false, restartPending: true, restartNeeded: true });
    await markRestarted(dist);
    // A rebuilt dist keeps deploy.json (the sticky restart state) while replacing the tree.
    await writeJavaDist(dist, await fixtureBuild(), "1.0.2");
    expect(await exists(join(dist, "deploy.json"))).toBe(true);
  });

  it("with geyser reload configured: an edited piece (pack only) needs no restart, a new piece (mappings) still does", async () => {
    const srv = await startFakeRcon("pw");
    const geyser3 = join(dir, "geyser3");
    const pack = join(dist, "geyser", "packs", "blockshop_family.mcpack");
    try {
      const cfg = { ...base, craftEngineDir: ce, geyserDir: geyser3, rcon: { host: "127.0.0.1", port: srv.port, password: "pw", timeoutMs: 5000 }, commands: ["ce reload all", "geyser reload"] };
      const first = await deployJava(cfg, dist, "1.0.1", silentLog);
      expect(first).toMatchObject({ mappingsChanged: true, packChanged: true, reloadedGeyser: true, restartNeeded: true });
      await markRestarted(dist);
      await writeFile(pack, Buffer.concat([await readFile(pack), Buffer.from("x")]));
      const edited = await deployJava(cfg, dist, "1.0.2", silentLog);
      expect(edited).toMatchObject({ mappingsChanged: false, packChanged: true, reloadedGeyser: true, restartNeeded: false, restarted: false });
      expect(edited.commands.map((c) => c.command)).toEqual(["ce reload all", "geyser reload"]);
      await writeFile(join(dist, "geyser", "custom_mappings", "blockshop_items.json"), (await readFile(join(dist, "geyser", "custom_mappings", "blockshop_items.json"), "utf8")) + "\n");
      const added = await deployJava(cfg, dist, "1.0.3", silentLog);
      expect(added).toMatchObject({ mappingsChanged: true, packChanged: false, reloadedGeyser: true, restartNeeded: true });
      await markRestarted(dist);
      await writeFile(pack, Buffer.concat([await readFile(pack), Buffer.from("y")]));
      const marker = join(dir, "restarted-pack-only");
      const editedWithRestart = await deployJava({ ...cfg, restartCommand: `touch ${marker}` }, dist, "1.0.4", silentLog);
      expect(editedWithRestart).toMatchObject({ packChanged: true, restarted: false, reloadedGeyser: true, restartNeeded: false });
      expect(await exists(marker)).toBe(false);
    } finally { await srv.close(); }
  });

  it("installs the catalog plugin jar (restart) and its pieces.json (no restart) into the plugins folder", async () => {
    const plugins = join(dir, "plugins-a");
    const jar = join(dir, "BlockshopCatalog.jar");
    await writeFile(jar, "jar v1");
    const cfg = { ...base, craftEngineDir: ce, geyserDir: join(dir, "geyser6"), pluginsDir: plugins, catalogJar: jar };
    const first = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(first).toMatchObject({ pluginChanged: true, catalogChanged: true, restartPending: true });
    expect(await readFile(join(plugins, "BlockshopCatalog.jar"), "utf8")).toBe("jar v1");
    expect(JSON.parse(await readFile(join(plugins, "BlockshopCatalog", "pieces.json"), "utf8"))).toMatchObject({ catalogItem: "blockshop:catalog", groups: [{ id: "family" }] });
    await markRestarted(dist);
    await writeFile(join(dist, "catalog", "pieces.json"), (await readFile(join(dist, "catalog", "pieces.json"), "utf8")) + "\n");
    const second = await deployJava(cfg, dist, "1.0.2", silentLog);
    expect(second).toMatchObject({ pluginChanged: false, catalogChanged: true, restartPending: false });
    await writeFile(jar, "jar v2");
    const third = await deployJava(cfg, dist, "1.0.3", silentLog);
    expect(third).toMatchObject({ pluginChanged: true, restartPending: true });
    await markRestarted(dist);
    const noJar = await deployJava({ ...cfg, catalogJar: "/nonexistent.jar" }, dist, "1.0.4", silentLog);
    expect(noJar).toMatchObject({ pluginChanged: false, restartPending: false });
  });

  it("keeps a restart pending across deploys until the log shows Geyser came back, or the admin says so", async () => {
    const geyser4 = join(dir, "geyser4");
    const log = join(dir, "latest.log");
    await writeFile(log, "[10:00:00 INFO]: Done (1s)!\n");
    const cfg = { ...base, craftEngineDir: ce, geyserDir: geyser4, mcLogFile: log };
    const first = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(first).toMatchObject({ mappingsChanged: true, restartPending: true, restartNeeded: true });
    expect(first.logMark).toBe((await readFile(log)).length);
    const second = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(second).toMatchObject({ mappingsChanged: false, packChanged: false, restartPending: true, restartNeeded: true, logMark: first.logMark });
    expect((await refreshDeployState(dist, cfg))!.restartPending).toBe(true);
    await writeFile(log, (await readFile(log, "utf8")) + "[10:05:00 INFO]: [Geyser-Spigot] Registered 8 custom blocks.\n");
    expect((await refreshDeployState(dist, cfg))!.restartPending).toBe(false);
    const third = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(third).toMatchObject({ restartPending: false, restartNeeded: false });
    await rm(geyser4, { recursive: true, force: true });
    const fourth = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(fourth.restartPending).toBe(true);
    await writeFile(log, "[00:00:01 INFO]: fresh\n");
    expect((await refreshDeployState(dist, cfg))!.restartPending).toBe(false);
    await rm(geyser4, { recursive: true, force: true });
    expect((await deployJava(cfg, dist, "1.0.1", silentLog)).restartPending).toBe(true);
    expect((await markRestarted(dist))!.restartPending).toBe(false);
    expect((await deployJava(cfg, dist, "1.0.1", silentLog)).restartPending).toBe(false);
  });

  it("waits for RCON after a restart and reports when the server does not come back", async () => {
    const srv = await startFakeRcon("pw");
    const port = srv.port;
    await srv.close();
    await expect(waitForRcon({ host: "127.0.0.1", port, password: "pw", timeoutMs: 1000 }, 1500, 300)).rejects.toThrow(/did not answer RCON/);
    const cfg = { ...base, craftEngineDir: ce, geyserDir: join(dir, "geyser5"), rcon: { host: "127.0.0.1", port, password: "pw", timeoutMs: 1000 }, commands: ["ce reload all"], restartCommand: "true", restartWaitMs: 1500 };
    const r = await deployJava(cfg, dist, "1.0.1", silentLog);
    expect(r.restarted).toBe(true);
    expect(r.error).toMatch(/did not answer RCON/);
    expect(r.restartPending).toBe(false);
  });

  it("runs the restart command instead of RCON when Geyser files changed, and RCON otherwise", async () => {
    const marker = join(dir, "restarted");
    const srv = await startFakeRcon("pw");
    try {
      const cfg = { ...base, craftEngineDir: ce, geyserDir: join(dir, "geyser2"), rcon: { host: "127.0.0.1", port: srv.port, password: "pw", timeoutMs: 5000 }, commands: ["ce reload all"], restartCommand: `touch ${marker}` };
      const r = await deployJava({ ...cfg, commands: ["ce reload all", "geyser reload"] }, dist, "1.0.1", silentLog);
      expect(r).toMatchObject({ geyserChanged: true, mappingsChanged: true, restarted: true, restartNeeded: false, error: null });
      expect(await exists(marker)).toBe(true);
      expect(r.commands.map((c) => c.command)).toEqual([`touch ${marker}`, "ce reload all"]);
      expect(srv.commands).toEqual(["ce reload all"]);
      srv.commands.length = 0;
      const again = await deployJava(cfg, dist, "1.0.1", silentLog);
      expect(again).toMatchObject({ geyserChanged: false, restarted: false, commands: [{ command: "ce reload all", response: "ok: ce reload all" }] });
      const bad = await deployJava({ ...cfg, rcon: { ...cfg.rcon, password: "wrong" } }, dist, "1.0.1", silentLog);
      expect(bad.error).toMatch(/authentication failed/);
      await rm(join(dir, "geyser2", "packs"), { recursive: true, force: true });
      const packOnly = await deployJava({ ...cfg, restartCommand: null }, dist, "1.0.1", silentLog);
      expect(packOnly).toMatchObject({ mappingsChanged: false, packChanged: true, reloadedGeyser: false, restartNeeded: true });
      await markRestarted(dist);
      await rm(join(dir, "geyser2", "packs"), { recursive: true, force: true });
      const unauth = await deployJava({ ...cfg, restartCommand: null, rcon: { ...cfg.rcon, password: "wrong" }, commands: ["geyser reload"] }, dist, "1.0.1", silentLog);
      expect(unauth).toMatchObject({ packChanged: true, reloadedGeyser: false, restartNeeded: true });
    } finally { await srv.close(); }
  });
});

describe("family server update over the API", () => {
  let dir: string;
  let ctx: AppContext;
  let srv: Awaited<ReturnType<typeof startFakeRcon>>;
  let token: string;
  const auth = () => ({ "x-admin-token": token });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "blockshop-server-"));
    srv = await startFakeRcon("pw", { respond: (c) => (c === "list" ? "There are 2 of a max of 20 players online: Steve, .Alex" : `ok: ${c}`) });
    await writeFile(join(dir, "BlockshopCatalog.jar"), "jar");
    ctx = await buildApp(loadConfig({
      DATA_DIR: join(dir, "data"), HOST_URL: "http://minecraft.local:8081", VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(dir, "none"),
      JAVA_DEPLOY: "on", CRAFTENGINE_DIR: join(dir, "plugins", "CraftEngine"), GEYSER_DIR: join(dir, "plugins", "Geyser-Spigot"), PLUGINS_DIR: join(dir, "plugins"),
      CATALOG_JAR: join(dir, "BlockshopCatalog.jar"), RCON_HOST: "127.0.0.1", RCON_PORT: String(srv.port), RCON_PASSWORD: "pw", JAVA_RCON_COMMANDS: "ce reload all; geyser reload",
    }));
    const s = await ctx.app.inject({ method: "POST", url: "/api/setup", payload: { pin: "1234", name: "Dad", icon: "🧔" } });
    token = s.json().token;
    await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth(), payload: { name: "Chloë-Mae", icon: "🦄" } });
  });
  afterAll(async () => { await ctx.app.close(); await srv.close(); await rm(dir, { recursive: true, force: true }); });

  it("status before anyone has drawn: nothing to send, restart would be needed, players listed", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/server" })).statusCode).toBe(401);
    const st = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth() })).json();
    expect(st).toMatchObject({ mode: "on", version: "1.0.0", changed: false, needsRestart: true, online: ["Steve", ".Alex"], rcon: true, restartCommand: false, build: null, lastDeploy: null, restartPending: false, statesLeft: 143, busy: false });
    expect(st.profiles).toEqual([
      { id: "dad", name: "Dad", icon: "🧔", onFamilyServer: true, pack: null, onServer: null, changed: false, pieces: 0 },
      { id: "chloe_mae", name: "Chloë-Mae", icon: "🦄", onFamilyServer: true, pack: null, onServer: null, changed: false, pieces: 0 },
    ]);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth() })).statusCode).toBe(422);
  });

  it("takes everyone's pieces as they are, makes their packs, allocates shared states, deploys, reports", async () => {
    const chair = await fixture("chair_asym");
    const table = await fixture("table");
    // A piece goes to the shared world only when someone chooses it; a new one starts off it.
    await ctx.app.inject({ method: "POST", url: "/api/profiles/dad/pieces", payload: { name: "Dad chair", voxels: chair.voxels, options: { ...chair.options, onFamilyServer: true } } });
    await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: "Chloë table", voxels: table.voxels, options: { onFamilyServer: true } } });
    await ctx.app.inject({ method: "POST", url: "/api/profiles/chloe_mae/pieces", payload: { name: "Still empty" } }); // no voxels: left out
    // Nobody pressed anything: the update itself makes each profile's pack, so an edit needs no other step.
    const before = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth() })).json();
    expect(before).toMatchObject({ changed: true, needsRestart: true });
    expect(before.profiles.map((p: { pack: string | null; onServer: string | null; changed: boolean; pieces: number }) => [p.pack, p.onServer, p.changed, p.pieces])).toEqual([[null, null, true, 1], [null, null, true, 1]]);

    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/server/update" })).statusCode).toBe(401);
    const res = await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ version: "1.0.1", profiles: { dad: "1.0.1", chloe_mae: "1.0.1" }, pieces: 2, warnings: [] });
    expect(r.deploy).toMatchObject({ mappingsChanged: true, packChanged: true, pluginChanged: true, catalogChanged: true, restarted: false, reloadedGeyser: true, restartNeeded: true, error: null });
    expect(r.deploy.commands.map((c: { command: string }) => c.command)).toEqual(["ce reload all", "geyser reload"]);

    const ceCfg = JSON.parse(await readFile(join(dir, "plugins", "CraftEngine", "resources", "blockshop", "configuration", "blockshop.json"), "utf8"));
    expect(Object.keys(ceCfg.items).sort()).toEqual(["blockshop:catalog", "chloe_mae:piece_1", "dad:piece_1"]);
    expect(ceCfg.items["chloe_mae:piece_1"].data.item_name).toBe("<!i>Chloë table");
    expect(Object.keys(ceCfg.categories).sort()).toEqual(["chloe_mae:furniture", "dad:furniture"]);
    expect((await readdir(join(dir, "plugins", "Geyser-Spigot", "packs"))).sort()).toEqual(["blockshop_chloe_mae.mcpack", "blockshop_dad.mcpack"]);
    const pieces = JSON.parse(await readFile(join(dir, "plugins", "BlockshopCatalog", "pieces.json"), "utf8"));
    expect(pieces.groups.map((g: { id: string; name: string; pieces: unknown[] }) => [g.id, g.name, g.pieces.length])).toEqual([["chloe_mae", "Chloë-Mae's Furniture", 1], ["dad", "Dad's Furniture", 1]]);
    const states = JSON.parse(await readFile(join(dir, "data", "server", "java-states.json"), "utf8"));
    expect(Object.keys(states.states).sort()).toEqual(["chloe_mae:piece_1", "dad:piece_1"]);
    expect(states.states["dad:piece_1"].north).not.toBe(states.states["chloe_mae:piece_1"].north);
    expect(JSON.parse(await readFile(join(dir, "data", "blockshop.json"), "utf8")).serverVersion).toEqual([1, 0, 1]);
    expect((await ctx.app.inject({ method: "GET", url: "/java/" })).statusCode).toBe(200);

    const after = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth() })).json();
    expect(after).toMatchObject({ version: "1.0.1", changed: false, needsRestart: true, restartPending: true, statesLeft: 135 });
    expect(after.profiles.map((p: { onServer: string | null }) => p.onServer)).toEqual(["1.0.1", "1.0.1"]);
    expect(after.build).toMatchObject({ version: "1.0.1", pieces: 2, profiles: { dad: "1.0.1", chloe_mae: "1.0.1" } });
    const cleared = (await ctx.app.inject({ method: "POST", url: "/api/admin/server/restarted", headers: auth() })).json();
    expect(cleared).toMatchObject({ restartPending: false, needsRestart: false, changed: false });
  });

  it("a renamed piece changes the Bedrock display name (restart); a reshaped one only the served pack (reload); states never move", async () => {
    // A rename, with nothing else pressed: the status sees it, and the item mapping's display_name changes.
    await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1", payload: { name: "Renamed later" } });
    const renamed = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth() })).json();
    expect(renamed).toMatchObject({ changed: true, needsRestart: true });
    expect(renamed.profiles[1]).toMatchObject({ id: "chloe_mae", pack: "1.0.1", onServer: "1.0.1", changed: true });
    const before = JSON.parse(await readFile(join(dir, "data", "server", "java-states.json"), "utf8"));
    const r1 = (await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth() })).json();
    expect(r1).toMatchObject({ version: "1.0.2", profiles: { dad: "1.0.1", chloe_mae: "1.0.2" } });
    expect(r1.deploy).toMatchObject({ mappingsChanged: true, packChanged: true, pluginChanged: false, restartNeeded: true });
    await ctx.app.inject({ method: "POST", url: "/api/admin/server/restarted", headers: auth() });
    // A reshaped piece: geometry lives in the served pack, the mapping is untouched.
    await ctx.app.inject({ method: "PUT", url: "/api/profiles/chloe_mae/pieces/piece_1", payload: { voxels: [{ x: 1, y: 0, z: 1, c: "red" }] } });
    const reshaped = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth() })).json();
    expect(reshaped).toMatchObject({ changed: true, needsRestart: false });
    const r2 = (await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth() })).json();
    expect(r2).toMatchObject({ version: "1.0.3", profiles: { dad: "1.0.1", chloe_mae: "1.0.3" } });
    expect(r2.deploy).toMatchObject({ mappingsChanged: false, packChanged: true, pluginChanged: false, reloadedGeyser: true, restartNeeded: false });
    expect(JSON.parse(await readFile(join(dir, "data", "server", "java-states.json"), "utf8"))).toEqual(before);
  });

  it("a removed profile leaves the server on the next update, its states stay taken", async () => {
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/admin/profiles/chloe_mae", headers: auth() })).statusCode).toBe(204);
    const st = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth() })).json();
    expect(st).toMatchObject({ changed: true, needsRestart: true });
    expect(st.profiles.map((p: { id: string }) => p.id)).toEqual(["dad"]);
    const r = (await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth() })).json();
    expect(r).toMatchObject({ version: "1.0.4", profiles: { dad: "1.0.1" }, pieces: 1 });
    expect(r.deploy).toMatchObject({ mappingsChanged: true, packChanged: true });
    expect((await readdir(join(dir, "plugins", "Geyser-Spigot", "packs"))).sort()).toEqual(["blockshop_dad.mcpack"]);
    const states = JSON.parse(await readFile(join(dir, "data", "server", "java-states.json"), "utf8"));
    expect(Object.keys(states.states).sort()).toEqual(["chloe_mae:piece_1", "dad:piece_1"]);
    expect(await exists(join(dir, "plugins", "CraftEngine", "resources", "blockshop", "resourcepack", "assets", "chloe_mae"))).toBe(false);
  });
  it("only chosen pieces and included profiles reach the server; the rest cost it nothing", async () => {
    const table = await fixture("table");
    const auth = { "x-admin-token": token };
    // A guest: their own packs work, the shared world never sees them.
    const guest = await ctx.app.inject({ method: "POST", url: "/api/admin/profiles", headers: auth, payload: { name: "Sam", icon: "🐸", role: "guest" } });
    expect(guest.json()).toMatchObject({ id: "sam", onFamilyServer: false });
    await ctx.app.inject({ method: "POST", url: "/api/profiles/sam/pieces", payload: { name: "Guest chair", voxels: table.voxels } });

    // Someone builds a new piece and leaves it as it comes: off the server until they choose it.
    const home = await ctx.app.inject({ method: "POST", url: "/api/profiles/dad/pieces", payload: { name: "Just for me", voxels: table.voxels } });
    expect(home.json().options.onFamilyServer).toBe(false);
    expect(home.statusCode, home.body).toBe(201);

    const before = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth })).json();
    const sam = before.profiles.find((p: { id: string }) => p.id === "sam");
    expect(sam).toMatchObject({ onFamilyServer: false, pieces: 0, onServer: null });
    const statesBefore = before.statesLeft;

    const r = (await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth })).json();
    expect(Object.keys(r.profiles)).not.toContain("sam");
    const ce = JSON.parse(await readFile(join(dir, "plugins", "CraftEngine", "resources", "blockshop", "configuration", "blockshop.json"), "utf8"));
    expect(Object.keys(ce.items)).not.toContain(`dad:${home.json().id}`);
    expect(Object.keys(ce.items).some((k) => k.startsWith("sam:"))).toBe(false);
    // Neither the guest nor the piece kept at home took a carrier state.
    const after = (await ctx.app.inject({ method: "GET", url: "/api/admin/server", headers: auth })).json();
    expect(statesBefore - after.statesLeft).toBe(0);
    expect(after.piecesLeft).toBe(Math.floor(after.statesLeft / 4));

    // Sharing it later puts it on the server, and that is when it takes its states.
    await ctx.app.inject({ method: "PUT", url: `/api/profiles/dad/pieces/${home.json().id}`, payload: { options: { onFamilyServer: true } } });
    const shared = (await ctx.app.inject({ method: "POST", url: "/api/admin/server/update", headers: auth })).json();
    expect(Object.keys(JSON.parse(await readFile(join(dir, "plugins", "CraftEngine", "resources", "blockshop", "configuration", "blockshop.json"), "utf8")).items)).toContain(`dad:${home.json().id}`);
    expect(shared.pieces).toBeGreaterThan(r.pieces);

    // The guest went home; the next test starts from the family again.
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/admin/profiles/sam", headers: auth })).statusCode).toBe(204);
  });
});
