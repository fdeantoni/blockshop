#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PieceSchema, ProjectSchema, type Piece } from "@blockshop/schema";
import { buildPack, jsonText } from "./pack.js";
import { previewTree, writeTree } from "./fs.js";
import { sanityCheck } from "./sanity.js";
import { zipMcaddon } from "./zip.js";
import { packFolderNames } from "./resources.js";
import { JavaStatesSchema, serverStateKey } from "@blockshop/schema";
import { allocateServerStates } from "./java-states.js";
import { buildServerPack, geyserMcpack, geyserPackNamespaces } from "./java-pack.js";
import { javaSanityCheck } from "./java-sanity.js";
import { geyserMcpackName } from "./geyser.js";

const USAGE = `usage: blockshop-gen [--project fixtures/project.json] [--out tmp] [--mcaddon] [--java] [--no-merge] [--all <dir>] [piece.json ...]

Writes <out>/packs/<bp>,<rp> (unzipped), <out>/preview/ (Blockbench files), <out>/report.json
and, with --mcaddon, <out>/<pack>-<version>.mcaddon.
With --java also <out>/java/: craftengine/ (CraftEngine pack), geyser/custom_mappings/, geyser/packs/blockshop_<namespace>.mcpack
(Java block states are allocated in memory when the project file has none).`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", default: "fixtures/project.json" },
      out: { type: "string", default: "tmp" },
      mcaddon: { type: "boolean", default: false },
      java: { type: "boolean", default: false },
      "no-merge": { type: "boolean", default: false },
      all: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }

  const project = ProjectSchema.parse(JSON.parse(await readFile(values.project, "utf8")));
  if (values["no-merge"]) project.generator.merge = false;

  const files = [...positionals];
  if (values.all) for (const f of (await readdir(values.all)).sort()) if (f.endsWith(".json")) files.push(join(values.all, f));
  if (files.length === 0) { console.error("no pieces given\n" + USAGE); return 2; }
  const pieces: Piece[] = [];
  for (const f of files) pieces.push(PieceSchema.parse(JSON.parse(await readFile(f, "utf8"))));

  const result = buildPack(project, pieces);
  const sanity = sanityCheck(project, pieces, result);
  const out = resolve(values.out);
  await writeTree(result.tree, join(out, "packs"));
  await writeTree(previewTree(result.tree), join(out, "preview"));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), jsonText({ ...result.report, sanity }));

  let mcaddonPath: string | undefined;
  if (values.mcaddon) {
    const { bp } = packFolderNames(project);
    mcaddonPath = join(out, `${bp.replace(/_bp$/, "")}-${project.version.join(".")}.mcaddon`);
    await writeFile(mcaddonPath, zipMcaddon(result.tree));
  }

  if (values.java) {
    const { states, added } = allocateServerStates(JavaStatesSchema.parse({}), pieces.map((pc) => serverStateKey(project.namespace, pc.id)));
    const input = { version: project.version, states, profiles: [{ project, pieces }] };
    const java = buildServerPack(input);
    const javaSanity = javaSanityCheck(input, java);
    for (const w of javaSanity.warnings) console.warn(`warning (java): ${w}`);
    for (const e of javaSanity.errors) console.error(`error (java): ${e}`);
    if (javaSanity.errors.length) return 1;
    const javaOut = join(out, "java");
    await writeTree(java.tree, javaOut);
    await mkdir(join(javaOut, "geyser", "packs"), { recursive: true });
    for (const ns of geyserPackNamespaces(java.tree)) await writeFile(join(javaOut, "geyser", "packs", geyserMcpackName(ns)), geyserMcpack(java.tree, ns));
    await writeFile(join(javaOut, "report.json"), jsonText(java.report));
    if (added.length) console.warn(`warning: Java states for ${added.join(", ")} were allocated in memory only (the server keeps the real table)`);
    for (const r of java.report.profiles.flatMap((pr) => pr.pieces)) console.log(`${r.javaId}: ${r.elements} elements, ${r.facesEmitted} faces, states ${r.states.south} …${r.seat ? ", seat" : ""}${r.hidden ? ", hidden" : ""}`);
    console.log(`java: ${java.tree.size} files → ${javaOut} (carrier ${java.report.carrier}, ${java.report.statesLeft} states left)`);
  }

  for (const r of result.report.pieces)
    console.log(`${r.identifier}: ${r.voxels} voxels → ${r.cubesAfterMerge} cubes, ${r.facesEmitted} faces, ${r.renderMethod}${r.seat ? ", seat" : ""}${r.hidden ? ", hidden" : ""}`);
  console.log(`${result.tree.size} files → ${join(out, "packs")}${mcaddonPath ? `, ${mcaddonPath}` : ""}`);
  for (const w of sanity.warnings) console.warn(`warning: ${w}`);
  for (const e of sanity.errors) console.error(`error: ${e}`);
  return sanity.errors.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
