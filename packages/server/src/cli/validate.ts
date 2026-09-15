#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { runMct, type McSuite } from "../validate.js";

const USAGE = "usage: blockshop-validate [--suite main|addon|all] [--report <dir>] <packs-dir>\n  <packs-dir> holds the unzipped BP and RP folders (e.g. tmp/packs).";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { suite: { type: "string", default: "main" }, report: { type: "string" }, help: { type: "boolean", default: false } },
  });
  if (values.help || positionals.length !== 1) { console.log(USAGE); return values.help ? 0 : 2; }
  const packsDir = resolve(positionals[0]!);
  const reportDir = values.report ? resolve(values.report) : join(packsDir, "..", "mct-report");
  const r = await runMct(packsDir, reportDir, { suite: values.suite as McSuite });
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  for (const e of r.errors) console.error(`error: ${e}`);
  console.log(`mct ${r.suite}: ${r.ok ? "OK" : "FAILED"} — ${r.errors.length} errors, ${r.warnings.length} warnings, ${r.infoCount} info in ${r.durationMs} ms; report: ${r.reportDir}`);
  return r.ok ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
