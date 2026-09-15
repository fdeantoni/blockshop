import type { JavaConfig } from "./config.js";
import { rconExec } from "./rcon.js";

/** Java names, with Floodgate's `.` prefix for Bedrock players. */
export const PLAYER_RE = /^\.?[A-Za-z0-9_]{1,16}$/;

export function stripColors(s: string): string {
  return s.replace(/§./g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** `There are 2 of a max of 20 players online: Steve, .Alex` → `["Steve", ".Alex"]` */
export function parsePlayerList(response: string): string[] {
  const text = stripColors(response);
  const i = text.indexOf(":");
  if (i < 0) return [];
  return text.slice(i + 1).split(",").map((s) => s.trim()).filter((s) => PLAYER_RE.test(s));
}

/** Who is on the family server right now (RCON `list`), so the grown-up can pick a quiet moment for a restart. */
export async function listPlayers(cfg: JavaConfig): Promise<string[]> {
  if (!cfg.rcon) throw new Error("RCON is not configured (RCON_PASSWORD)");
  const [reply] = await rconExec({ ...cfg.rcon, timeoutMs: Math.min(cfg.rcon.timeoutMs, 15_000) }, ["list"]);
  return parsePlayerList(reply?.response ?? "");
}
