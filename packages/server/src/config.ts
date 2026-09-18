import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { McSuite } from "./validate.js";

/** `on`: the grown-up page can update the family server. Nothing else touches it. (`manual`/`publish` from older env files read as `on`.) */
export type JavaDeployMode = "off" | "on";

/** CraftEngine rebuilds and re-sends the Java pack; Geyser re-reads the served Bedrock pack (verified 2026-09-15). */
export const DEFAULT_RCON_COMMANDS = "ce reload all; geyser reload";

/** Paper/CraftEngine/Geyser export (docs/family-server-internals.md). Blockshop must run on the server host. */
export interface JavaConfig {
  /** off: no family-server export. on: the grown-up page builds and deploys it on request. */
  mode: JavaDeployMode;
  /** plugins/CraftEngine (the pack goes to resources/blockshop/) */
  craftEngineDir: string | null;
  /** plugins/Geyser-Spigot (custom_mappings/ and packs/) */
  geyserDir: string | null;
  /** The server's plugins/ folder: receives BlockshopCatalog.jar and BlockshopCatalog/pieces.json. Optional. */
  pluginsDir: string | null;
  /** The built catalog plugin jar (in the Docker image at /app/plugin/BlockshopCatalog.jar). */
  catalogJar: string;
  rcon: { host: string; port: number; password: string; timeoutMs: number } | null;
  /** RCON commands after a deploy; default `ce reload all; geyser reload` (the latter kicks Bedrock players, who rejoin with the new pack). */
  commands: string[];
  /** Shell command that restarts Paper, run when the Geyser mappings changed (Geyser reads them at startup only). */
  restartCommand: string | null;
  /** How long to wait for RCON after the restart command before giving up on the post-restart reload (JAVA_RESTART_WAIT_MS). */
  restartWaitMs: number;
  /** The server's logs/latest.log, if mounted: lets Blockshop notice a restart (Geyser's "Registered … custom blocks" line) and clear the pending flag. */
  mcLogFile: string | null;
}

export interface Config {
  port: number;
  host: string;
  /** Public base URL as the iPads reach it, e.g. http://minecraft.local:8080 (no trailing slash). */
  hostUrl: string;
  dataDir: string;
  validate: boolean;
  mctSuite: McSuite;
  /** Built editor SPA; served at / when it exists. */
  editorDir: string;
  uiTitle: string;
  logLevel: string;
  /** Replaces the grown-up PIN at start (recovery when it was forgotten); otherwise the setup screen sets it. */
  adminPin: string | null;
  java: JavaConfig;
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : !/^(0|false|no|off)$/i.test(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env["PORT"] ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${env["PORT"]}`);
  const mctSuite = (env["MCT_SUITE"] ?? "main") as McSuite;
  const modeRaw = (env["JAVA_DEPLOY"] || "off").toLowerCase();
  if (!["off", "on", "manual", "publish"].includes(modeRaw)) throw new Error(`JAVA_DEPLOY must be off or on, got ${modeRaw}`);
  const mode: JavaDeployMode = modeRaw === "off" ? "off" : "on";
  const java: JavaConfig = {
    mode,
    craftEngineDir: env["CRAFTENGINE_DIR"] ? resolve(env["CRAFTENGINE_DIR"]) : null,
    geyserDir: env["GEYSER_DIR"] ? resolve(env["GEYSER_DIR"]) : null,
    pluginsDir: env["PLUGINS_DIR"] ? resolve(env["PLUGINS_DIR"]) : null,
    catalogJar: resolve(env["CATALOG_JAR"] ?? fileURLToPath(new URL("../../../plugin/target/BlockshopCatalog.jar", import.meta.url))),
    rcon: env["RCON_PASSWORD"]
      ? { host: env["RCON_HOST"] || "127.0.0.1", port: Number(env["RCON_PORT"] || 25575), password: env["RCON_PASSWORD"], timeoutMs: Number(env["RCON_TIMEOUT_MS"] || 120_000) }
      : null,
    commands: (env["JAVA_RCON_COMMANDS"] ?? DEFAULT_RCON_COMMANDS).split(";").map((c) => c.trim()).filter(Boolean),
    restartCommand: env["JAVA_RESTART_COMMAND"] || null,
    restartWaitMs: Number(env["JAVA_RESTART_WAIT_MS"] || 180_000),
    mcLogFile: env["MC_LOG_FILE"] ? resolve(env["MC_LOG_FILE"]) : null,
  };
  if (java.mode !== "off" && (!java.craftEngineDir || !java.geyserDir)) throw new Error(`JAVA_DEPLOY=${java.mode} needs CRAFTENGINE_DIR and GEYSER_DIR`);
  if (java.rcon && (!Number.isInteger(java.rcon.port) || java.rcon.port <= 0)) throw new Error(`RCON_PORT must be a positive integer, got ${env["RCON_PORT"]}`);
  if (java.rcon && (!Number.isInteger(java.rcon.timeoutMs) || java.rcon.timeoutMs <= 0)) throw new Error(`RCON_TIMEOUT_MS must be a positive integer, got ${env["RCON_TIMEOUT_MS"]}`);
  if (!Number.isInteger(java.restartWaitMs) || java.restartWaitMs <= 0) throw new Error(`JAVA_RESTART_WAIT_MS must be a positive integer, got ${env["JAVA_RESTART_WAIT_MS"]}`);
  return {
    port,
    host: env["HOST"] ?? "0.0.0.0",
    hostUrl: (env["HOST_URL"] ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    dataDir: resolve(env["DATA_DIR"] ?? "data"),
    validate: bool(env["VALIDATE"], true),
    mctSuite,
    editorDir: resolve(env["EDITOR_DIR"] ?? fileURLToPath(new URL("../../editor/dist", import.meta.url))),
    uiTitle: env["UI_TITLE"] ?? "Blockshop",
    logLevel: env["LOG_LEVEL"] ?? "info",
    adminPin: env["ADMIN_PIN"] || null,
    java,
  };
}
