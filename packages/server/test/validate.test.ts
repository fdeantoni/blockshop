import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PieceSchema, ProjectSchema } from "@blockshop/schema";
import { buildPack, writeTree } from "@blockshop/generator";
import { csvRecords, parseCsv } from "../src/csv.js";
import { classifyRows, mctCliPath, runMct } from "../src/validate.js";

describe("csv", () => {
  it("parses quoted fields, embedded commas, doubled quotes and CRLF", () => {
    const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\n"multi\nline",,\n');
    expect(rows).toEqual([["a", "b", "c"], ["1", "x, y", 'he said "hi"'], ["multi\nline", "", ""]]);
    expect(csvRecords("Test,Type\nJSON,Warning\n")).toEqual([{ Test: "JSON", Type: "Warning" }]);
  });
});

describe("classifyRows", () => {
  it("maps mct types to errors and warnings", () => {
    const r = classifyRows([
      { Test: "X", TestId: "1", Type: "Error", Message: "bad", Data: "", Path: "/p" },
      { Test: "Y", TestId: "0", Type: "Test fail", Message: "failed", Data: "", Path: "" },
      { Test: "Z", TestId: "2", Type: "Warning", Message: "meh", Data: "detail", Path: "" },
      { Test: "Z", TestId: "3", Type: "Recommendation", Message: "consider", Data: "", Path: "" },
      { Test: "I", TestId: "4", Type: "Info", Message: "fyi", Data: "", Path: "" },
      { Test: "S", TestId: "5", Type: "Test success", Message: "ok", Data: "", Path: "" },
    ]);
    expect(r.errors).toEqual(["X/1: bad (/p)", "Y/0: failed"]);
    expect(r.warnings).toEqual(["Z/2: meh — detail", "Z/3: consider"]);
    expect(r.infoCount).toBe(1);
  });
});

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const skip = process.env["BLOCKSHOP_SKIP_MCT"] === "1";

describe.skipIf(skip)("mct integration", () => {
  it("locates the CLI", () => {
    expect(mctCliPath()).toMatch(/creator-tools\/cli\/index\.mjs$/);
  });
  it("main suite passes on the generated fixture pack", { timeout: 120000 }, async () => {
    const project = ProjectSchema.parse(JSON.parse(readFileSync(fixtures + "project.json", "utf8")));
    const pieces = ["chair_asym", "glass_cabinet", "table"].map((id) => PieceSchema.parse(JSON.parse(readFileSync(`${fixtures}pieces/${id}.json`, "utf8"))));
    const dir = await mkdtemp(join(tmpdir(), "blockshop-mct-"));
    const packs = join(dir, "packs");
    await writeTree(buildPack(project, pieces).tree, packs);
    const r = await runMct(packs, join(dir, "report"));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.infoCount).toBeGreaterThan(10);
    // No structural JSON warnings on our own files; anything else is surfaced, not fatal.
    expect(r.warnings.filter((w) => w.startsWith("JSON/"))).toEqual([]);
  });
});
