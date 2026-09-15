import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { rollback } from "../src/rollback.js";

describe("rollback", () => {
  it("restores the snapshot's pieces, parks newer ones, keeps the version counter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blockshop-rb-"));
    const { app, workspace } = await buildApp(loadConfig({ DATA_DIR: dir, VALIDATE: "0", LOG_LEVEL: "silent", EDITOR_DIR: join(dir, "none") }));
    await app.inject({ method: "POST", url: "/api/setup", payload: { pin: "1234", name: "Dad", icon: "🧔" } });
    const store = await workspace.storeFor("dad");
    await app.inject({ method: "POST", url: "/api/profiles/dad/pieces", payload: { name: "A", voxels: [{ x: 1, y: 0, z: 1, c: "oak" }] } });
    await app.inject({ method: "POST", url: "/api/profiles/dad/publish" }); // 1.0.1 with A
    await app.inject({ method: "PUT", url: "/api/profiles/dad/pieces/piece_1", payload: { name: "A changed", voxels: [{ x: 2, y: 0, z: 2, c: "red" }] } });
    await app.inject({ method: "POST", url: "/api/profiles/dad/pieces", payload: { name: "B", voxels: [{ x: 3, y: 0, z: 3, c: "oak" }] } });
    await app.inject({ method: "POST", url: "/api/profiles/dad/publish" }); // 1.0.2 with A changed + B

    const r = await rollback(store, "1.0.1");
    expect(r).toMatchObject({ version: "1.0.1", restoredPieces: 1, parkedPieces: 1, nextVersion: "1.0.3" });
    expect(r.parkedDir).toMatch(/pieces-parked-/);
    expect((await readdir(r.parkedDir!)).sort()).toEqual(["piece_2.json"]);
    const a = JSON.parse(await readFile(store.piecePath("piece_1"), "utf8"));
    expect(a.name).toBe("A");
    expect(a.voxels).toEqual([{ x: 1, y: 0, z: 1, c: "oak" }]);
    expect((await store.getProject()).version).toEqual([1, 0, 2]);
    expect((await store.getProject()).nextPieceNumber).toBe(3);
    const res = await app.inject({ method: "POST", url: "/api/profiles/dad/publish" });
    expect(res.json().versionString).toBe("1.0.3");
    expect(res.json().pieceCount).toBe(1);
    await expect(rollback(store, "9.9.9")).rejects.toThrow(/no usable history/);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
});
