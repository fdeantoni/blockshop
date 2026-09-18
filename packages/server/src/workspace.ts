import { mkdir, readFile, rename } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  JavaStatesSchema, MAX_PROFILES, PinSchema, ProfileSchema, RESERVED_PROFILE_IDS, WorkspaceSchema, packNameFor, profileIdFromName,
  type JavaStates, type Profile, type ProfileRole, type Version, type Workspace as WorkspaceState,
} from "@blockshop/schema";
import { atomicWrite, ProjectError, Store } from "./store.js";

export const WORKSPACE_FILE = "blockshop.json";
const MAX_SESSIONS = 10;

/**
 * DATA_DIR layout: blockshop.json (profiles, grown-up PIN, server export version), profiles/<id>/ (one Store
 * each: project.json, pieces, thumbnails, dist, history), server/ (shared Java states and the merged export),
 * deleted/ (folders of removed profiles, kept for the grown-up).
 */
export class Workspace {
  private lock: Promise<unknown> = Promise.resolve();
  private stores = new Map<string, Promise<Store>>();
  constructor(readonly dataDir: string) {}

  get file() { return join(this.dataDir, WORKSPACE_FILE); }
  get profilesDir() { return join(this.dataDir, "profiles"); }
  get deletedDir() { return join(this.dataDir, "deleted"); }
  /** Family-server export: shared Java states, merged build, deploy state. */
  get serverDir() { return join(this.dataDir, "server"); }
  get serverJavaDir() { return join(this.serverDir, "dist", "java"); }
  /** The carrier-state table shared by every profile (append-only, world state). */
  get statesFile() { return join(this.serverDir, "java-states.json"); }
  profileDir(id: string) { return join(this.profilesDir, id); }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async init(opts: { adminPin?: string | null } = {}): Promise<WorkspaceState> {
    await mkdir(this.profilesDir, { recursive: true });
    await mkdir(this.serverJavaDir, { recursive: true });
    let ws: WorkspaceState;
    try {
      ws = await this.get();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      ws = WorkspaceSchema.parse({});
      await this.save(ws);
    }
    if (opts.adminPin) {
      PinSchema.parse(opts.adminPin);
      ws = { ...ws, admin: { ...hashPin(opts.adminPin), sessions: ws.admin?.sessions ?? [] } };
      await this.save(ws);
    }
    for (const p of ws.profiles) await this.store(p.id);
    return ws;
  }

  async get(): Promise<WorkspaceState> {
    return WorkspaceSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
  }

  async save(ws: WorkspaceState): Promise<void> {
    await atomicWrite(this.file, JSON.stringify(WorkspaceSchema.parse(ws), null, 2) + "\n");
  }

  private store(id: string): Promise<Store> {
    let s = this.stores.get(id);
    if (!s) {
      const st = new Store(this.profileDir(id));
      s = st.init().then(() => st);
      this.stores.set(id, s);
    }
    return s;
  }

  // ---- profiles

  async listProfiles(): Promise<Profile[]> {
    return (await this.get()).profiles;
  }

  async getProfile(id: string): Promise<Profile> {
    const p = (await this.get()).profiles.find((x) => x.id === id);
    if (!p) throw new ProjectError(`no such profile: ${id}`, 404);
    return p;
  }

  /** The profile's store; 404 for unknown ids, so a typo never creates a folder. */
  async storeFor(id: string): Promise<Store> {
    await this.getProfile(id);
    return this.store(id);
  }

  async createProfile(input: { name: string; icon: string; role: ProfileRole; onFamilyServer?: boolean | undefined }): Promise<Profile> {
    return this.withLock(async () => {
      const ws = await this.get();
      if (ws.profiles.length >= MAX_PROFILES) throw new ProjectError(`at most ${MAX_PROFILES} profiles`, 409);
      const taken = new Set<string>([...ws.profiles.map((p) => p.id), ...ws.retired, ...RESERVED_PROFILE_IDS]);
      const profile = ProfileSchema.parse({
        id: profileIdFromName(input.name, taken), name: input.name, icon: input.icon, role: input.role,
        // A guest is here for an afternoon: their furniture stays in their own worlds unless a grown-up says otherwise.
        onFamilyServer: input.onFamilyServer ?? input.role !== "guest",
        createdAt: new Date().toISOString(),
      });
      const store = new Store(this.profileDir(profile.id));
      await store.init({ namespace: profile.id, packName: packNameFor(profile.name) });
      this.stores.set(profile.id, Promise.resolve(store));
      await this.save({ ...ws, profiles: [...ws.profiles, profile] });
      return profile;
    });
  }

  async updateProfile(id: string, patch: { name?: string | undefined; icon?: string | undefined; onFamilyServer?: boolean | undefined }): Promise<Profile> {
    return this.withLock(async () => {
      const ws = await this.get();
      const i = ws.profiles.findIndex((p) => p.id === id);
      if (i < 0) throw new ProjectError(`no such profile: ${id}`, 404);
      const updated = ProfileSchema.parse({ ...ws.profiles[i], ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.icon !== undefined ? { icon: patch.icon } : {}), ...(patch.onFamilyServer !== undefined ? { onFamilyServer: patch.onFamilyServer } : {}) });
      const profiles = [...ws.profiles];
      profiles[i] = updated;
      await this.save({ ...ws, profiles });
      if (updated.name !== ws.profiles[i]!.name) {
        const store = await this.store(id);
        await store.saveProject({ ...(await store.getProject()), packName: packNameFor(updated.name) });
      }
      return updated;
    });
  }

  /** Moves the folder to deleted/ and retires the id: its Java states stay taken on the family server. */
  async deleteProfile(id: string): Promise<void> {
    return this.withLock(async () => {
      const ws = await this.get();
      const profile = ws.profiles.find((p) => p.id === id);
      if (!profile) throw new ProjectError(`no such profile: ${id}`, 404);
      if (profile.role === "grownup" && ws.profiles.filter((p) => p.role === "grownup").length === 1) throw new ProjectError("the last grown-up profile cannot be removed", 409);
      await mkdir(this.deletedDir, { recursive: true });
      await rename(this.profileDir(id), join(this.deletedDir, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
      this.stores.delete(id);
      await this.save({ ...ws, profiles: ws.profiles.filter((p) => p.id !== id), retired: [...ws.retired, id] });
    });
  }

  // ---- family server bookkeeping

  async readStates(): Promise<JavaStates> {
    try {
      return JavaStatesSchema.parse(JSON.parse(await readFile(this.statesFile, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return JavaStatesSchema.parse({});
    }
  }

  async saveStates(states: JavaStates): Promise<void> {
    await atomicWrite(this.statesFile, JSON.stringify(JavaStatesSchema.parse(states), null, 2) + "\n");
  }

  /** Next export version: bumped and persisted before a build, so a failed update never reuses one. */
  async bumpServerVersion(): Promise<Version> {
    return this.withLock(async () => {
      const ws = await this.get();
      const v: Version = [ws.serverVersion[0], ws.serverVersion[1], ws.serverVersion[2] + 1];
      await this.save({ ...ws, serverVersion: v });
      return v;
    });
  }

  // ---- the grown-up PIN

  async setupNeeded(): Promise<boolean> {
    return (await this.get()).admin === null;
  }

  /** Sets (or replaces) the PIN; every browser has to enter it again. Returns a session for the caller. */
  async setPin(pin: string): Promise<string> {
    PinSchema.parse(pin);
    return this.withLock(async () => {
      const token = newToken();
      await this.save({ ...(await this.get()), admin: { ...hashPin(pin), sessions: [token] } });
      return token;
    });
  }

  /** A session token when the PIN matches, else null. */
  async login(pin: string): Promise<string | null> {
    return this.withLock(async () => {
      const ws = await this.get();
      if (!ws.admin || !checkPin(pin, ws.admin)) return null;
      const token = newToken();
      await this.save({ ...ws, admin: { ...ws.admin, sessions: [...ws.admin.sessions.slice(-(MAX_SESSIONS - 1)), token] } });
      return token;
    });
  }

  async hasSession(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const ws = await this.get();
    return ws.admin?.sessions.includes(token) ?? false;
  }

  async logout(token: string): Promise<void> {
    return this.withLock(async () => {
      const ws = await this.get();
      if (!ws.admin) return;
      await this.save({ ...ws, admin: { ...ws.admin, sessions: ws.admin.sessions.filter((t) => t !== token) } });
    });
  }
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

function hashPin(pin: string): { pinHash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  return { salt, pinHash: scryptSync(pin, salt, 32).toString("hex") };
}

function checkPin(pin: string, admin: { pinHash: string; salt: string }): boolean {
  if (!PinSchema.safeParse(pin).success) return false;
  const h = scryptSync(pin, admin.salt, 32);
  const stored = Buffer.from(admin.pinHash, "hex");
  return h.length === stored.length && timingSafeEqual(h, stored);
}
