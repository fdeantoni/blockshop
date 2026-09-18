import type { PaletteEntry, Piece, PieceOptions, Voxel, Version } from "@blockshop/schema";

export interface ProfileInfo {
  id: string; name: string; icon: string; role: "grownup" | "kid" | "guest"; createdAt: string; onFamilyServer: boolean;
  namespace: string; packName: string; version: Version; versionString: string;
  palette: PaletteEntry[]; latest: { version: string; mcaddonUrl: string } | null; makingPack: boolean; hasIconPng: boolean;
  pieceCount: number; maxPieces: number;
}
export interface WorkspaceInfo { uiTitle: string; version: string; setupNeeded: boolean; maxProfiles: number; maxPieces: number; profiles: ProfileInfo[] }
export interface PieceSummary {
  id: string; name: string; author: string; hidden: boolean; updatedAt: string; createdAt: string;
  voxelCount: number; hasThumbnail: boolean; publishedInVersion?: Version; onFamilyServer: boolean;
}
export interface RconReply { command: string; response: string }
export interface JavaDeployResult {
  at: string; version: string; geyserChanged: boolean; mappingsChanged: boolean; packChanged: boolean; pluginChanged: boolean; catalogChanged: boolean; restarted: boolean; reloadedGeyser: boolean;
  restartPending: boolean; restartNeeded: boolean; commands: RconReply[]; error: string | null;
}
export interface ServerProfileStatus { id: string; name: string; icon: string; onFamilyServer: boolean; pack: string | null; onServer: string | null; changed: boolean; pieces: number }
export interface ServerStatus {
  mode: "off" | "on"; version: string; profiles: ServerProfileStatus[]; changed: boolean; needsRestart: boolean | null;
  online: string[] | null; onlineError: string | null; rcon: boolean; restartCommand: boolean; logWatched: boolean;
  build: { version: string; at: string; pieces: number; profiles: Record<string, string> } | null; lastDeploy: JavaDeployResult | null;
  restartPending: boolean; statesLeft: number; piecesLeft: number; busy: boolean;
}
export interface ServerUpdateResult { version: string; profiles: Record<string, string>; pieces: number; warnings: string[]; deploy: JavaDeployResult }
export interface PackResult {
  version: Version; versionString: string; mcaddonFile: string; mcaddonUrl: string;
  pieceCount: number; cubeCount: number; warnings: string[]; durationMs: number;
  validation: { ok: boolean; errors: string[]; warnings: string[] } | null;
  /** false when nothing changed since the last pack: the same file, the same version. */
  rebuilt: boolean;
}
export interface HistoryEntry { version: string; mcaddon: string | null; size: number; publishedAt: string }
export interface PiecePatch { name?: string; author?: string; voxels?: Voxel[]; options?: PieceOptions }
export interface AdminInfo { profiles: ProfileInfo[]; retired: string[]; maxProfiles: number }
/** The live packs a tablet's own worlds read from their development pack folders (docs/ipad-setup.md). */
export interface DevPackInfo {
  archive: { file: string; url: string };
  dirs: { bp: string; rp: string };
  profiles: Array<{
    namespace: string;
    packName: string;
    folders: { bp: string; rp: string };
    archive: { file: string; url: string };
    pieces: Array<{ identifier: string; name: string }>;
    skipped: Array<{ id: string; reason: string }>;
    warnings: string[];
  }>;
  builtAt: string;
  hash: string;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly details?: unknown) { super(message); }
}

const TOKEN_KEY = "blockshop.admin";
export function adminToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setAdminToken(token: string | null): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* fine */ }
}

async function call<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {};
  const token = adminToken();
  if (token) headers["x-admin-token"] = token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : null, ...init });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

const p = (pid: string) => `/api/profiles/${encodeURIComponent(pid)}`;

export const api = {
  workspace: () => call<WorkspaceInfo>("GET", "/api/workspace"),
  setup: (body: { pin: string; name: string; icon: string }) => call<{ token: string; profile: ProfileInfo }>("POST", "/api/setup", body),
  // grown-up page
  login: (pin: string) => call<{ token: string }>("POST", "/api/admin/login", { pin }),
  logout: () => call<void>("POST", "/api/admin/logout"),
  admin: () => call<AdminInfo>("GET", "/api/admin"),
  changePin: (pin: string) => call<{ token: string }>("PUT", "/api/admin/pin", { pin }),
  addProfile: (body: { name: string; icon: string; role?: "kid" | "guest" }) => call<ProfileInfo>("POST", "/api/admin/profiles", body),
  updateProfile: (pid: string, patch: { name?: string; icon?: string; onFamilyServer?: boolean }) => call<ProfileInfo>("PUT", `/api/admin/profiles/${encodeURIComponent(pid)}`, patch),
  deleteProfile: (pid: string) => call<void>("DELETE", `/api/admin/profiles/${encodeURIComponent(pid)}`),
  server: () => call<ServerStatus>("GET", "/api/admin/server"),
  serverUpdate: () => call<ServerUpdateResult>("POST", "/api/admin/server/update"),
  serverRestarted: () => call<ServerStatus>("POST", "/api/admin/server/restarted"),
  devPack: () => call<DevPackInfo>("GET", "/api/dev"),
  // one profile
  profile: (pid: string) => call<ProfileInfo>("GET", p(pid)),
  setIcon: (pid: string, icon: string) => call<ProfileInfo>("PUT", `${p(pid)}/icon`, { icon }),
  pieces: (pid: string) => call<PieceSummary[]>("GET", `${p(pid)}/pieces`),
  piece: (pid: string, id: string) => call<Piece>("GET", `${p(pid)}/pieces/${id}`),
  create: (pid: string, patch: PiecePatch) => call<Piece>("POST", `${p(pid)}/pieces`, patch),
  update: (pid: string, id: string, patch: PiecePatch, keepalive = false) => call<Piece>("PUT", `${p(pid)}/pieces/${id}`, patch, { keepalive }),
  remove: (pid: string, id: string) => call<void>("DELETE", `${p(pid)}/pieces/${id}`),
  hide: (pid: string, id: string) => call<Piece>("POST", `${p(pid)}/pieces/${id}/hide`),
  unhide: (pid: string, id: string) => call<Piece>("POST", `${p(pid)}/pieces/${id}/unhide`),
  thumbnail: (pid: string, id: string, dataUrl: string) => call<void>("PUT", `${p(pid)}/pieces/${id}/thumbnail`, { dataUrl }),
  thumbnailUrl: (pid: string, id: string, updatedAt: string) => `${p(pid)}/pieces/${id}/thumbnail.png?t=${encodeURIComponent(updatedAt)}`,
  pack: (pid: string) => call<PackResult>("POST", `${p(pid)}/pack`),
  setIconPng: (pid: string, dataUrl: string) => call<void>("PUT", `${p(pid)}/icon.png`, { dataUrl }),
  history: (pid: string) => call<HistoryEntry[]>("GET", `${p(pid)}/history`),
};
