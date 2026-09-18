import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { serverStateKey, type JavaStates, type Piece, type Profile } from "@blockshop/schema";
import {
  CATALOG_JSON, GEYSER_BLOCKS_FILE, GEYSER_ITEMS_FILE, JAVA_DIRS, allocateServerStates, buildServerPack, carrierStateCount, javaSanityCheck,
  type JavaBuildReport, type ServerBuildInput, type ServerProfileInput,
} from "@blockshop/generator";
import type { Config, JavaConfig } from "./config.js";
import { CATALOG_PLUGIN, JAVA_BUILD_STATE, deployJava, markRestarted, readJson, refreshDeployState, writeJavaDist, type JavaBuildState, type JavaDeployResult } from "./java-deploy.js";
import { packInputHash, type PackBuilder } from "./pack.js";
import { listPlayers } from "./java-players.js";
import { ProjectError, type Store } from "./store.js";
import type { Workspace } from "./workspace.js";

export interface ServerProfileStatus {
  id: string;
  name: string;
  icon: string;
  /** Whether the family server carries this profile at all (a guest is usually off it). */
  onFamilyServer: boolean;
  /** The profile's current pack version, or null before it ever made one. */
  pack: string | null;
  /** The pack version the family server's last update was built from, or null. */
  onServer: string | null;
  /** Whether this profile's pieces changed since that update. */
  changed: boolean;
  /** Pieces the next update would take from this profile (everything drawn). */
  pieces: number;
}

export interface ServerStatus {
  mode: JavaConfig["mode"];
  version: string;
  profiles: ServerProfileStatus[];
  /** Whether an update would put anything new on the server. */
  changed: boolean;
  /** Whether that update needs a server restart (mappings, plugin jar) rather than a reload. null when the mode is off. */
  needsRestart: boolean | null;
  /** Players online right now (RCON `list`); null when RCON is off or the server did not answer (see onlineError). */
  online: string[] | null;
  onlineError: string | null;
  rcon: boolean;
  restartCommand: boolean;
  logWatched: boolean;
  build: JavaBuildState | null;
  lastDeploy: JavaDeployResult | null;
  restartPending: boolean;
  statesLeft: number;
  /** Pieces the family server still has room for: four carrier states each, and states are never reused. */
  piecesLeft: number;
  busy: boolean;
}

export interface ServerUpdateResult {
  version: string;
  profiles: Record<string, string>;
  pieces: number;
  warnings: string[];
  deploy: JavaDeployResult;
  report: JavaBuildReport;
}

/**
 * What one profile would put on the server right now: the pieces it has chosen for it, empty ones left out.
 * A piece with no choice recorded counts as chosen, so nothing already on the server falls off.
 */
async function currentSnapshot(store: Store): Promise<{ pieces: Piece[]; hash: string; packVersion: string | null }> {
  const project = await store.getProject();
  const pieces = (await store.listPieces()).filter((p) => p.voxels.length > 0 && p.options.onFamilyServer !== false);
  let packVersion: string | null = null;
  try {
    packVersion = ((JSON.parse(await readFile(join(store.packsDir, "latest.json"), "utf8")) as { version: number[] }).version).join(".");
  } catch { packVersion = null; }
  return { pieces, hash: packInputHash(project, pieces, await store.readIconPng()), packVersion };
}

/**
 * The family server's export: every profile's pieces as they are saved, merged into one CraftEngine pack, one
 * Geyser mapping and one served pack per profile, deployed on the grown-up's request only. Nothing else touches
 * the server, so nobody gets kicked by someone else's edit.
 */
export class ServerExporter {
  private inFlight: Promise<unknown> | null = null;
  constructor(
    private readonly workspace: Workspace,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
    /** Each profile's pack builder: an update makes every profile's pack file current first (see `run`). */
    private readonly packBuilderFor: (pid: string) => Promise<PackBuilder>,
  ) {}

  get busy(): boolean { return this.inFlight !== null; }
  private get dir(): string { return this.workspace.serverJavaDir; }

  /** Everything the next update would be built from, with states allocated in memory (nothing persisted). */
  private async collect(): Promise<{ input: ServerBuildInput; versions: Record<string, string>; hashes: Record<string, string>; profiles: Profile[]; snapshots: Map<string, { version: string | null; hash: string; pieces: number }> }> {
    const profiles = await this.workspace.listProfiles();
    const inputs: ServerProfileInput[] = [];
    const versions: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    const snapshots = new Map<string, { version: string | null; hash: string; pieces: number }>();
    for (const p of profiles) {
      // A profile kept off the family server costs it nothing: no pieces, no carrier states, no mapping.
      if (!p.onFamilyServer) continue;
      const store = await this.workspace.storeFor(p.id);
      const snap = await currentSnapshot(store);
      if (snap.pieces.length === 0) continue;
      if (snap.packVersion) versions[p.id] = snap.packVersion;
      hashes[p.id] = snap.hash;
      snapshots.set(p.id, { version: snap.packVersion, hash: snap.hash, pieces: snap.pieces.length });
      inputs.push({
        project: await store.getProject(), pieces: snap.pieces,
        thumbnails: await store.readThumbnails(snap.pieces.map((x) => x.id)),
        packIcon: await store.readIconPng(),
      });
    }
    const keys = inputs.flatMap((i) => i.pieces.map((x) => serverStateKey(i.project.namespace, x.id)));
    const { states } = allocateServerStates(await this.workspace.readStates(), keys);
    const ws = await this.workspace.get();
    return { input: { version: ws.serverVersion, states, profiles: inputs }, versions, hashes, profiles, snapshots };
  }

  async status(): Promise<ServerStatus> {
    const cfg = this.config.java;
    const ws = await this.workspace.get();
    const lastDeploy = cfg.mode === "off" ? null : await refreshDeployState(this.dir, cfg);
    const build = await readJson<JavaBuildState>(join(this.dir, JAVA_BUILD_STATE));
    const { input, profiles, snapshots } = await this.collect();
    // Exact per profile: the pieces the last update was built from are recorded as a hash, because a
    // pack version only moves when someone makes a pack, and editing alone must still count as changed.
    const statuses: ServerProfileStatus[] = profiles.map((p) => ({
      id: p.id, name: p.name, icon: p.icon, onFamilyServer: p.onFamilyServer,
      pack: snapshots.get(p.id)?.version ?? null,
      onServer: build?.profiles[p.id] ?? null,
      changed: snapshots.has(p.id) && snapshots.get(p.id)!.hash !== build?.hashes?.[p.id],
      pieces: snapshots.get(p.id)?.pieces ?? 0,
    }));
    // Nobody has drawn anything: an update is refused, so nothing counts as changed.
    const anything = input.profiles.length > 0;
    let changed = anything && (statuses.some((s) => s.changed) || Object.keys(build?.hashes ?? build?.profiles ?? {}).some((id) => !snapshots.has(id)));
    let needsRestart: boolean | null = null;
    if (cfg.mode !== "off" && cfg.geyserDir) {
      // Exact, not estimated: the merged build is pure, so compare what deploy would write with what is there.
      try {
        const built = buildServerPack({ ...input, version: ws.serverVersion });
        const differs = async (rel: string, target: string) => !(await sameContent(built.tree.get(rel), target));
        const mappings = (await differs(`${JAVA_DIRS.geyser}/${GEYSER_BLOCKS_FILE}`, join(cfg.geyserDir, GEYSER_BLOCKS_FILE)))
          || (await differs(`${JAVA_DIRS.geyser}/${GEYSER_ITEMS_FILE}`, join(cfg.geyserDir, GEYSER_ITEMS_FILE)));
        let plugin = false;
        if (cfg.pluginsDir) {
          try { plugin = !Buffer.from(await readFile(cfg.catalogJar)).equals(await readFile(join(cfg.pluginsDir, `${CATALOG_PLUGIN}.jar`)).catch(() => Buffer.alloc(0))); } catch { plugin = false; }
          if (anything && (await differs(`${JAVA_DIRS.catalog}/${CATALOG_JSON}`, join(cfg.pluginsDir, CATALOG_PLUGIN, CATALOG_JSON)))) changed = true;
        }
        needsRestart = mappings || plugin || (lastDeploy?.restartPending ?? false);
        if (anything && (mappings || plugin)) changed = true;
      } catch (e) {
        this.log.warn({ err: e }, "server status: could not build the export in memory");
      }
    }
    let online: string[] | null = null;
    let onlineError: string | null = null;
    if (cfg.mode !== "off" && cfg.rcon) {
      try { online = await listPlayers(cfg); } catch (e) { onlineError = e instanceof Error ? e.message : String(e); }
    }
    return {
      mode: cfg.mode, version: ws.serverVersion.join("."), profiles: statuses, changed, needsRestart, online, onlineError,
      rcon: cfg.rcon !== null, restartCommand: cfg.restartCommand !== null, logWatched: cfg.mcLogFile !== null,
      build, lastDeploy, restartPending: lastDeploy?.restartPending ?? false,
      statesLeft: carrierStateCount(input.states.carrier) - input.states.cursor,
      piecesLeft: Math.floor((carrierStateCount(input.states.carrier) - input.states.cursor) / 4),
      busy: this.busy,
    };
  }

  /** Build from every profile's pieces as they are now and put it on the server. One at a time. */
  update(): Promise<ServerUpdateResult> {
    if (this.inFlight) throw new ProjectError("a server update is already in progress", 409);
    const p = this.run().finally(() => { this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  private async run(): Promise<ServerUpdateResult> {
    const cfg = this.config.java;
    if (cfg.mode === "off") throw new ProjectError("JAVA_DEPLOY is off on this server", 409);
    // Every profile's pack file is brought up to date first: that is where the Creator Tools validation
    // runs, and it leaves the version, history and "this piece is out there" marks the server relies on.
    // A profile with nothing drawn yet is simply not on the server.
    for (const p of await this.workspace.listProfiles()) {
      if (!p.onFamilyServer) continue;
      const store = await this.workspace.storeFor(p.id);
      if ((await store.listPieces()).every((x) => x.voxels.length === 0)) continue;
      const builder = await this.packBuilderFor(p.id);
      try {
        const r = await ensurePack(builder);
        if (r.rebuilt) this.log.info({ profile: p.id, version: r.versionString }, "pack refreshed for the server update");
      } catch (e) {
        if (e instanceof ProjectError) throw new ProjectError(`${p.name}: ${e.message}`, e.status);
        throw e;
      }
    }
    const { input, versions, hashes } = await this.collect();
    if (input.profiles.length === 0) throw new ProjectError("nothing to put on the server: nobody has drawn a piece yet", 422);
    // States first (append-only, world state), then the version, then the build: a failed build never reuses either.
    const persisted: JavaStates = await this.workspace.withLock(async () => {
      const current = await this.workspace.readStates();
      const { states, added, dropped } = allocateServerStates(current, Object.keys(input.states.states));
      if (added.length || dropped.length) await this.workspace.saveStates(states);
      if (dropped.length) this.log.warn({ pieces: dropped, carrier: states.carrier }, "Java carrier changed: states reassigned, furniture placed under the old carrier is now the vanilla block");
      if (added.length) this.log.info({ pieces: added, carrier: states.carrier }, "allocated Java block states");
      return states;
    });
    const version = await this.workspace.bumpServerVersion();
    const versionString = version.join(".");
    const log = this.log.child({ serverUpdate: versionString });
    const built = buildServerPack({ ...input, states: persisted, version });
    const sanity = javaSanityCheck({ ...input, states: persisted, version }, built);
    if (sanity.errors.length) throw new ProjectError(`server export failed sanity checks: ${sanity.errors.join("; ")}`, 500);
    await writeJavaDist(this.dir, built, versionString, versions, hashes);
    log.info({ files: built.tree.size, statesLeft: built.report.statesLeft, profiles: versions }, "server export built");
    const deploy = await deployJava(cfg, this.dir, versionString, log);
    return { version: versionString, profiles: versions, pieces: built.report.profiles.reduce((n, p) => n + p.pieces.length, 0), warnings: sanity.warnings, deploy, report: built.report };
  }

  /** The grown-up restarted the server by hand: nothing is owed any more. */
  async markRestarted(): Promise<ServerStatus> {
    await markRestarted(this.dir);
    return this.status();
  }
}

async function sameContent(built: string | Uint8Array | undefined, path: string): Promise<boolean> {
  if (built === undefined) return false;
  try {
    const bytes = typeof built === "string" ? Buffer.from(built, "utf8") : Buffer.from(built);
    return bytes.equals(await readFile(path));
  } catch { return false; }
}

/** One retry when a kid's own download is running at that moment; anything else is the caller's problem. */
async function ensurePack(builder: PackBuilder) {
  try {
    return await builder.ensure();
  } catch (e) {
    if (!(e instanceof ProjectError) || e.status !== 409) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return builder.ensure();
  }
}
