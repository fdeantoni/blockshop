import { describe, it, expect } from "vitest";
import { rconExec } from "../src/rcon.js";
import { startFakeRcon } from "./fake-rcon.js";

describe("rcon client", () => {
  it("authenticates and runs commands in order", async () => {
    const srv = await startFakeRcon("secret");
    try {
      const replies = await rconExec({ host: "127.0.0.1", port: srv.port, password: "secret" }, ["ce reload all", "say hi"]);
      expect(replies).toEqual([{ command: "ce reload all", response: "ok: ce reload all" }, { command: "say hi", response: "ok: say hi" }]);
      expect(srv.commands).toEqual(["ce reload all", "say hi"]);
    } finally { await srv.close(); }
  });

  it("joins split replies", async () => {
    const srv = await startFakeRcon("secret", { split: true });
    try {
      const replies = await rconExec({ host: "127.0.0.1", port: srv.port, password: "secret" }, ["ce reload all"]);
      expect(replies[0]!.response).toBe("ok: ce reload all");
    } finally { await srv.close(); }
  });

  it("rejects on a wrong password and on a closed port", async () => {
    const srv = await startFakeRcon("secret");
    try {
      await expect(rconExec({ host: "127.0.0.1", port: srv.port, password: "nope" }, ["x"])).rejects.toThrow(/authentication failed/);
    } finally { await srv.close(); }
    await expect(rconExec({ host: "127.0.0.1", port: srv.port, password: "secret", timeoutMs: 2000 }, ["x"])).rejects.toThrow(/rcon 127.0.0.1/);
  });
});
