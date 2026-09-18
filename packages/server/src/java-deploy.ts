import { cp, mkdir, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import {
  CATALOG_JSON, CRAFTENGINE_PACK_FOLDER, GEYSER_BLOCKS_FILE, GEYSER_ITEMS_FILE, GEYSER_MCPACK_RE, JAVA_DIRS,
  geyserMcpack, geyserMcpackName, geyserPackNamespaces, jsonText, writeTree, type JavaBuildResult,
} from "@blockshop/generator";

/** Plugin name = jar name = data folder name under plugins/. */
export const CATALOG_PLUGIN = "BlockshopCatalog";
import type { JavaConfig } from "./config.js";
import { rconExec, type RconReply } from "./rcon.js";

export const JAVA_DEPLOY_STATE = "deploy.json";
export const JAVA_BUILD_STATE = "build.json";

/** What the last merged build contained (build.json next to the export). */
export interface JavaBuildState {
  version: string;
  at: string;
  pieces: number;
  /** Profile id → the pack version of that profile when the build was made (absent before its first pack). */
  profiles: Record<string, string>;
  /** Profile id → hash of the pieces the build was made from; how "changed since" is decided. */
  hashes?: Record<string, string>;
}

export interface JavaDeployResult {
  at: string;
  version: string;
  craftEngineDir: string;
  geyserDir: string;
  /** Either Geyser file changed (mappings or the served pack). */
  geyserChanged: boolean;
  /** The block or item mappings changed (new piece, renamed, light or bounds changed): Geyser reads those at startup only. */
  mappingsChanged: boolean;
  /** A served .mcpack changed or went away (every update bumps their version): `geyser reload` re-reads them (verified 2026-09-15). */
  packChanged: boolean;
  /** BlockshopCatalog.jar was installed or updated: Paper loads plugin jars at startup only. */
  pluginChanged: boolean;
  /** pieces.json for the catalog plugin was written (the plugin re-reads it on every menu open). */
  catalogChanged: boolean;
  restarted: boolean;
  /** A `geyser reload` command ran without error. */
  reloadedGeyser: boolean;
  /**
   * A restart is still owed: this or an earlier deploy changed the mappings and the server has not restarted
   * since. Sticky across deploys; cleared by our own restart command, by `markRestarted`, or when the server
   * log (MC_LOG_FILE) shows Geyser registering its custom blocks again.
   */
  restartPending: boolean;
  /** Same as `restartPending`; what the Ready card shows after this deploy. */
  restartNeeded: boolean;
  /** Byte offset in MC_LOG_FILE when the restart became pending; the log is scanned from here. */
  logMark: number | null;
  commands: RconReply[];
  error: string | null;
}

async function logSize(path: string | null): Promise<number | null> {
  if (!path) return null;
  try { return (await stat(path)).size; } catch { return null; }
}

/** True when the server log shows a (Geyser) startup after `mark`: the file was rotated (restart) or has the registration line past the mark. */
export async function restartSeenInLog(path: string | null, mark: number | null): Promise<boolean> {
  if (!path || mark === null) return false;
  let size: number;
  try { size = (await stat(path)).size; } catch { return false; }
  if (size < mark) return true; // Paper rotates latest.log on every start
  const fh = await openFile(path, "r");
  try {
    const len = size - mark;
    const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
    await fh.read(buf, 0, buf.length, mark);
    return /Registered \d+ custom block/.test(buf.toString("utf8"));
  } finally { await fh.close(); }
}

/** Re-evaluate a stored deploy result: clear the pending restart when the log shows the server came back. */
export async function refreshDeployState(distJavaDir: string, cfg: Pick<JavaConfig, "mcLogFile">): Promise<JavaDeployResult | null> {
  const path = join(distJavaDir, JAVA_DEPLOY_STATE);
  const state = await readJson<JavaDeployResult>(path);
  if (!state) return null;
  if (state.restartPending && (await restartSeenInLog(cfg.mcLogFile, state.logMark))) {
    state.restartPending = false; state.restartNeeded = false; state.logMark = null;
    await writeFile(path, jsonText(state));
  }
  return state;
}

/** The grown-up says the server was restarted (Admin button). */
export async function markRestarted(distJavaDir: string): Promise<JavaDeployResult | null> {
  const path = join(distJavaDir, JAVA_DEPLOY_STATE);
  const state = await readJson<JavaDeployResult>(path);
  if (!state) return null;
  state.restartPending = false; state.restartNeeded = false; state.logMark = null;
  await writeFile(path, jsonText(state));
  return state;
}

/** Write a build to server/dist/java: the unzipped tree, one .mcpack per profile for Geyser, and the report. */
export async function writeJavaDist(dir: string, result: JavaBuildResult, version: string, profiles: Record<string, string> = {}, hashes: Record<string, string> = {}): Promise<void> {
  // Replace the tree wholesale (a removed profile must not leave files behind) but keep deploy.json, the sticky restart state.
  for (const sub of Object.values(JAVA_DIRS)) await rm(join(dir, sub), { recursive: true, force: true });
  await writeTree(result.tree, dir, { clear: false });
  const packs = join(dir, JAVA_DIRS.geyser, "packs");
  await mkdir(packs, { recursive: true });
  for (const ns of geyserPackNamespaces(result.tree)) await writeFile(join(packs, geyserMcpackName(ns)), geyserMcpack(result.tree, ns));
  await writeFile(join(dir, "report.json"), jsonText(result.report));
  const state: JavaBuildState = { version, at: new Date().toISOString(), pieces: result.report.profiles.reduce((n, p) => n + p.pieces.length, 0), profiles, hashes };
  await writeFile(join(dir, JAVA_BUILD_STATE), jsonText(state));
}

export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

async function sameBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  try { return Buffer.from(bytes).equals(await readFile(path)); } catch { return false; }
}

/** Copy a file only when its content differs; returns whether it was written. */
async function syncFile(src: string, dest: string): Promise<boolean> {
  const bytes = await readFile(src);
  if (await sameBytes(dest, bytes)) return false;
  await mkdir(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  return true;
}

const isGeyserReload = (command: string) => /^geyser\s+reload\b/.test(command.trim());

/** Poll until RCON accepts the password (the server is back after a restart) or the timeout passes. */
export async function waitForRcon(rcon: NonNullable<JavaConfig["rcon"]>, timeoutMs: number, intervalMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try { await rconExec({ ...rcon, timeoutMs: Math.min(rcon.timeoutMs, 10_000) }, []); return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`server did not answer RCON within ${Math.round(timeoutMs / 1000)} s after the restart${last instanceof Error ? ` (${last.message})` : ""}`);
}

function sh(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command}: ${err.message}${stderr ? `\n${stderr}` : ""}`));
      else resolve(`${stdout}${stderr}`.trim());
    });
  });
}

/**
 * Put the last build in front of the running server: replace the CraftEngine pack folder, sync the
 * Geyser mappings and pack, then either restart the server (if Geyser files changed and a restart
 * command is configured) or reload CraftEngine over RCON. File errors reject; command errors are
 * reported in `error` because the files are already in place.
 */
export async function deployJava(cfg: JavaConfig, distJavaDir: string, version: string, log: FastifyBaseLogger): Promise<JavaDeployResult> {
  if (!cfg.craftEngineDir || !cfg.geyserDir) throw new Error("JAVA_DEPLOY needs CRAFTENGINE_DIR and GEYSER_DIR");
  const previous = await refreshDeployState(distJavaDir, cfg);
  const result: JavaDeployResult = {
    at: new Date().toISOString(), version, craftEngineDir: cfg.craftEngineDir, geyserDir: cfg.geyserDir,
    geyserChanged: false, mappingsChanged: false, packChanged: false, pluginChanged: false, catalogChanged: false, restarted: false, reloadedGeyser: false,
    restartPending: previous?.restartPending ?? false, restartNeeded: false, logMark: previous?.logMark ?? null,
    commands: [], error: null,
  };

  // 1. CraftEngine pack: build the new folder next to the old one, then swap, so a reload never sees a half-written pack.
  const src = join(distJavaDir, JAVA_DIRS.craftengine);
  const target = join(cfg.craftEngineDir, "resources", CRAFTENGINE_PACK_FOLDER);
  const staging = `${target}.new-${randomBytes(4).toString("hex")}`;
  await mkdir(join(cfg.craftEngineDir, "resources"), { recursive: true });
  await cp(src, staging, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);

  // 2. Geyser: mappings and the served packs (one per profile), written only when they differ. Any Blockshop
  //    pack not in this build (a removed profile, an earlier layout's file) is dropped: Geyser serves every file there.
  const geyserSrc = join(distJavaDir, JAVA_DIRS.geyser);
  for (const rel of [GEYSER_BLOCKS_FILE, GEYSER_ITEMS_FILE]) {
    if (await syncFile(join(geyserSrc, rel), join(cfg.geyserDir, rel))) result.mappingsChanged = true;
  }
  const packs = (await readdir(join(geyserSrc, "packs")).catch(() => [] as string[])).filter((f) => f.endsWith(".mcpack"));
  await mkdir(join(cfg.geyserDir, "packs"), { recursive: true });
  for (const f of packs) {
    if (await syncFile(join(geyserSrc, "packs", f), join(cfg.geyserDir, "packs", f))) result.packChanged = true;
  }
  for (const f of await readdir(join(cfg.geyserDir, "packs")).catch(() => [] as string[])) {
    if (GEYSER_MCPACK_RE.test(f) && !packs.includes(f)) { await rm(join(cfg.geyserDir, "packs", f), { force: true }); result.packChanged = true; }
  }
  result.geyserChanged = result.mappingsChanged || result.packChanged;

  // 2b. Catalog plugin: the jar (startup only) and its pieces.json (re-read on every menu open).
  if (cfg.pluginsDir) {
    const dataDir = join(cfg.pluginsDir, CATALOG_PLUGIN);
    if (await syncFile(join(distJavaDir, JAVA_DIRS.catalog, CATALOG_JSON), join(dataDir, CATALOG_JSON))) result.catalogChanged = true;
    try {
      await stat(cfg.catalogJar);
      if (await syncFile(cfg.catalogJar, join(cfg.pluginsDir, `${CATALOG_PLUGIN}.jar`))) result.pluginChanged = true;
    } catch {
      log.warn({ jar: cfg.catalogJar }, "java deploy: catalog plugin jar not found, the menu plugin is not installed");
    }
  }

  // 3. Make the server pick it up. Geyser re-reads the served pack on `geyser reload` (Bedrock players are
  //    kicked and rejoin) but its block/item mappings only at startup, so new pieces need a restart.
  const reloadsGeyser = cfg.commands.some(isGeyserReload);
  const needsRestart = result.mappingsChanged || result.pluginChanged || result.restartPending || (result.packChanged && !reloadsGeyser);
  try {
    if (needsRestart && cfg.restartCommand) {
      log.info({ command: cfg.restartCommand, mappingsChanged: result.mappingsChanged }, "java deploy: restarting the server");
      result.commands.push({ command: cfg.restartCommand, response: await sh(cfg.restartCommand, 180_000) });
      result.restarted = true;
      // CraftEngine serves its last *uploaded* pack after a start; only a reload regenerates it from the new
      // config. Geyser reads everything fresh at startup, so its reload is not needed (and would kick players again).
      const afterRestart = cfg.commands.filter((c) => !isGeyserReload(c));
      if (cfg.rcon && afterRestart.length) {
        await waitForRcon(cfg.rcon, cfg.restartWaitMs);
        result.commands.push(...(await rconExec(cfg.rcon, afterRestart)));
      }
    } else if (cfg.rcon && cfg.commands.length) {
      result.commands = await rconExec(cfg.rcon, cfg.commands);
      result.reloadedGeyser = result.commands.some((c) => isGeyserReload(c.command));
    } else if (cfg.commands.length) {
      log.warn("java deploy: no RCON_PASSWORD configured, skipping the reload commands");
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    log.error({ err: e }, "java deploy: command failed");
  }
  if (result.restarted) {
    result.restartPending = false; result.logMark = null;
  } else if (result.mappingsChanged || result.pluginChanged || (result.packChanged && !result.reloadedGeyser)) {
    if (!result.restartPending) result.logMark = await logSize(cfg.mcLogFile);
    result.restartPending = true;
  }
  result.restartNeeded = result.restartPending;
  await writeFile(join(distJavaDir, JAVA_DEPLOY_STATE), jsonText(result));
  log.info({ version, mappingsChanged: result.mappingsChanged, packChanged: result.packChanged, pluginChanged: result.pluginChanged, catalogChanged: result.catalogChanged, restarted: result.restarted, reloadedGeyser: result.reloadedGeyser, restartPending: result.restartPending, error: result.error }, "java deployed");
  return result;
}
