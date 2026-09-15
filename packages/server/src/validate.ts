import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { csvRecords } from "./csv.js";

export type McSuite = "main" | "default" | "addon" | "currentplatform" | "all";

export interface McToolsResult {
  ok: boolean;
  suite: McSuite;
  errors: string[];
  warnings: string[];
  infoCount: number;
  exitCode: number | null;
  durationMs: number;
  /** Folder holding <name>.csv, <name>.mcr.json and <name>.report.html. */
  reportDir: string;
}

/** Path to the Minecraft Creator Tools CLI entry shipped in node_modules. */
export function mctCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@minecraft/creator-tools/package.json");
  const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8")) as { bin: { mct: string } };
  return join(dirname(pkgPath), pkg.bin.mct);
}

/** Classify a report row. Errors fail a publish; warnings and recommendations are surfaced. */
export function classifyRows(rows: Record<string, string>[]): { errors: string[]; warnings: string[]; infoCount: number } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let infoCount = 0;
  for (const r of rows) {
    const line = `${r["Test"]}/${r["TestId"]}: ${r["Message"]}${r["Data"] ? ` — ${r["Data"]}` : ""}${r["Path"] ? ` (${r["Path"]})` : ""}`;
    switch (r["Type"]) {
      case "Error": case "Test fail": errors.push(line); break;
      case "Warning": case "Recommendation": warnings.push(line); break;
      case "Info": infoCount++; break;
      default: break; // "Test success", "Unknown"
    }
  }
  return { errors, warnings, infoCount };
}

/**
 * Run `mct validate <suite>` on an unzipped pack folder (containing the BP and RP
 * folders) and parse the CSV report. Offline mode so it works on a LAN box.
 */
export async function runMct(packsDir: string, reportDir: string, opts: { suite?: McSuite; timeoutMs?: number } = {}): Promise<McToolsResult> {
  const suite = opts.suite ?? "main";
  const started = Date.now();
  await rm(reportDir, { recursive: true, force: true });
  await mkdir(reportDir, { recursive: true });
  const args = [mctCliPath(), "validate", suite, "-i", packsDir, "-o", reportDir, "--offline"];
  // Curated environment: mct falls silent under a test runner's NODE_ENV/NODE_PATH/TEST
  // variables, so pass only what a Node CLI needs.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "SYSTEMROOT"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", ...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`mct timed out after ${opts.timeoutMs ?? 120000} ms`)); }, opts.timeoutMs ?? 120000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: out }); });
  });
  let rows: Record<string, string>[] = [];
  try {
    rows = csvRecords(await readFile(join(reportDir, `${basename(packsDir)}.csv`), "utf8"));
  } catch {
    return { ok: false, suite, errors: [`mct produced no report (exit ${code}): ${output.trim().slice(-800)}`], warnings: [], infoCount: 0, exitCode: code, durationMs: Date.now() - started, reportDir };
  }
  const { errors, warnings, infoCount } = classifyRows(rows);
  if (code !== 0 && errors.length === 0) errors.push(`mct exited with code ${code}: ${output.trim().slice(-800)}`);
  return { ok: errors.length === 0, suite, errors, warnings, infoCount, exitCode: code, durationMs: Date.now() - started, reportDir };
}
