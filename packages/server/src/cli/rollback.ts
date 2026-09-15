#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { rollback } from "../rollback.js";
import { Workspace } from "../workspace.js";

const USAGE = `usage: blockshop-rollback --profile <id> [--data-dir <dir>] [--list] <version>
Restores a profile's pieces and palette from profiles/<id>/history/<version>/; publish afterwards to ship them as a new version.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "data-dir": { type: "string" }, profile: { type: "string" }, list: { type: "boolean", default: false }, help: { type: "boolean", default: false } },
  });
  if (values.help) { console.log(USAGE); return 0; }
  const workspace = new Workspace(resolve(values["data-dir"] ?? process.env["DATA_DIR"] ?? "data"));
  await workspace.init();
  if (!values.profile) {
    console.error(USAGE);
    for (const p of await workspace.listProfiles()) console.error(`  profile ${p.id}: ${p.name}`);
    return 2;
  }
  const store = await workspace.storeFor(values.profile);
  if (values.list) {
    for (const h of await store.listHistory()) console.log(`${h.version}\t${h.publishedAt}\t${h.mcaddon ?? "-"}`);
    return 0;
  }
  const version = positionals[0];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) { console.error(USAGE); return 2; }
  const r = await rollback(store, version);
  console.log(`restored ${r.restoredPieces} pieces from ${r.version}${r.parkedPieces ? `; parked ${r.parkedPieces} newer pieces in ${r.parkedDir}` : ""}`);
  console.log(`now publish (POST /api/profiles/${values.profile}/publish or the editor) to ship them as version ${r.nextVersion}`);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
