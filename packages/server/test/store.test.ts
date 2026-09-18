import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, ensureDefaultPalette, newProject } from "@blockshop/schema";
import { Store } from "../src/store.js";

const uuids = { bp: "0c7c5cbe-8ee1-4541-860e-76b24a23e9d7", rp: "d79847ce-948b-4e46-a911-d5650115d2cb", bpModule: "bc58241e-5e80-4a18-80bb-a41388ac216b", rpModule: "8cba11ff-808f-4f52-8a03-329d10fa12e3", scriptModule: "98e8fae2-20b2-42b2-ac2b-ee950cfa47c0" };

describe("palette migration", () => {
  let dir: string;
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("appends missing default colours to an older project, keeping existing entries and order", async () => {
    dir = await mkdtemp(join(tmpdir(), "blockshop-store-"));
    const old = newProject(uuids, { palette: DEFAULT_PALETTE.slice(0, 10).map((p) => ({ ...p, label: p.label.toUpperCase() })) });
    await writeFile(join(dir, "project.json"), JSON.stringify(old));
    const store = new Store(dir);
    const project = await store.init();
    expect(project.palette).toHaveLength(DEFAULT_PALETTE.length);
    expect(project.palette.slice(0, 10).map((p) => p.label)).toEqual(old.palette.map((p) => p.label)); // untouched
    expect(project.palette.slice(10).map((p) => p.id)).toEqual(DEFAULT_PALETTE.slice(10).map((p) => p.id));
    const saved = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
    expect(saved.palette).toHaveLength(DEFAULT_PALETTE.length);
    expect(ensureDefaultPalette(project).added).toEqual([]);
  });
});

describe("piece order", () => {
  it("is the order they were made, past the tenth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blockshop-order-"));
    const store = new Store(dir);
    await store.init();
    for (let i = 0; i < 12; i++) await store.createPiece({ name: `P${i + 1}` });
    const ids = (await store.listPieces()).map((p) => p.id);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `piece_${i + 1}`));
    expect((await store.listSummaries()).map((p) => p.id)).toEqual(ids);
    await rm(dir, { recursive: true, force: true });
  });
});
