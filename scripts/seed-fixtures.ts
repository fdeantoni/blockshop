/**
 * Seed DATA_DIR with a "family" profile holding fixtures/project.json and fixtures/pieces/*.json, so the
 * server's packs share UUIDs with packs generated from the fixtures (pnpm gen). The grown-up PIN is not
 * set: the editor shows the setup screen, which adds the grown-up's own profile next to this one. Refuses
 * to overwrite an existing profile unless --force. Run: pnpm seed [--force]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const force = process.argv.includes("--force");
const dataDir = resolve(process.env["DATA_DIR"] ?? "data");
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const profileDir = join(dataDir, "profiles", "family");
const workspacePath = join(dataDir, "blockshop.json");
if (existsSync(join(profileDir, "project.json")) && !force) {
  console.error(`${profileDir} exists; pass --force to overwrite its project.json and fixture pieces`);
  process.exit(1);
}
mkdirSync(join(profileDir, "pieces"), { recursive: true });
copyFileSync(join(fixtures, "project.json"), join(profileDir, "project.json"));
const pieces = readdirSync(join(fixtures, "pieces")).filter((f) => f.endsWith(".json"));
for (const f of pieces) copyFileSync(join(fixtures, "pieces", f), join(profileDir, "pieces", f));
const ws = existsSync(workspacePath) ? JSON.parse(readFileSync(workspacePath, "utf8")) as { profiles?: Array<{ id: string }> } : {};
const profiles = (ws.profiles ?? []).filter((p) => p.id !== "family");
profiles.push({ id: "family", name: "Family", icon: "🏠", role: "kid", createdAt: new Date().toISOString() } as { id: string });
writeFileSync(workspacePath, JSON.stringify({ ...ws, profiles }, null, 2) + "\n");
console.log(`seeded ${profileDir}: project.json + ${pieces.length} pieces (${pieces.map((f) => f.replace(".json", "")).join(", ")}); profile "family" in ${workspacePath}`);
