import { sanitizeDisplayName, type BlockSound, type Piece, type Project } from "@blockshop/schema";
import { blockIdentifier, textureName } from "./block.js";

export function packFolderNames(project: Pick<Project, "packName">): { bp: string; rp: string } {
  const slug = project.packName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "pack";
  return { bp: `${slug}_bp`, rp: `${slug}_rp` };
}

export function buildBlocksJson(project: Project, entries: Array<{ id: string; sound: BlockSound }>) {
  const json: Record<string, unknown> = { format_version: [1, 1, 0] };
  for (const e of entries) json[blockIdentifier(project, e.id)] = { sound: e.sound };
  return json;
}

export function buildTerrainTexture(project: Project) {
  // One-element arrays: Bedrock treats a string and a single-variation array the same,
  // and the community JSON schema used by mct only accepts the array form.
  const textureData: Record<string, { textures: string[] }> = {};
  for (const p of project.palette) {
    const name = textureName(project.namespace, p.id);
    textureData[name] = { textures: [`textures/blocks/${name}`] };
  }
  return {
    resource_pack_name: project.packName,
    texture_name: "atlas.terrain",
    padding: 8,
    num_mip_levels: 4,
    texture_data: textureData,
  };
}

export function buildLang(project: Project, pieces: readonly Piece[], opts: { seats: boolean } = { seats: false }): string {
  const lines = pieces.map((p) => `tile.${blockIdentifier(project, p.id)}.name=${sanitizeDisplayName(p.name, p.id)}`);
  if (opts.seats) {
    const seat = `${project.namespace}:seat`;
    lines.push(
      "action.interact.sit=Sit",
      `entity.${seat}.name=Seat`,
      // Hint shown after mounting (seen on device as a raw key); both key forms Minecraft has used.
      `action.hint.action.${seat}=Sneak to stand up`,
      `action.hint.exit.${seat}=Sneak to stand up`,
    );
  }
  return lines.join("\n") + "\n";
}

export function buildManifests(project: Project, opts: { scripts: boolean; pieceCount: number }) {
  const { version, uuids, minEngineVersion } = project;
  // Minecraft shows no version for local packs, but it shows the description under the pack
  // name in every pack list; the name must stay constant so imports keep replacing the pack.
  const description = `Blockshop v${version.join(".")} · ${opts.pieceCount} piece${opts.pieceCount === 1 ? "" : "s"}`;
  const bpModules: unknown[] = [{ type: "data", uuid: uuids.bpModule, version }];
  const dependencies: unknown[] = [{ uuid: uuids.rp, version }];
  if (opts.scripts) {
    bpModules.push({ type: "script", language: "javascript", uuid: uuids.scriptModule, entry: "scripts/main.js", version });
    dependencies.push({ module_name: "@minecraft/server", version: project.scriptApiVersion });
  }
  const bp = {
    format_version: 2,
    header: { name: project.packName, description, uuid: uuids.bp, version, min_engine_version: minEngineVersion },
    modules: bpModules,
    dependencies,
  };
  const rp = {
    format_version: 2,
    header: { name: project.packName, description, uuid: uuids.rp, version, min_engine_version: minEngineVersion },
    modules: [{ type: "resources", uuid: uuids.rpModule, version }],
  };
  return { bp, rp };
}
