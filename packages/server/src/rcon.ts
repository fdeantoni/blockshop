import { Socket } from "node:net";

/**
 * Minimal Source RCON client (what Minecraft servers speak): int32 LE length, int32 id, int32 type,
 * body, two NUL bytes. Type 3 = auth (answered with type 2, id −1 on a wrong password), type 2 =
 * command (answered with type 0, possibly split over several packets for long outputs).
 */
export interface RconOptions { host: string; port: number; password: string; timeoutMs?: number }
export interface RconReply { command: string; response: string }

export class RconError extends Error {}

const AUTH = 3, EXEC = 2, AUTH_RESPONSE = 2, RESPONSE = 0;

export function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buf.writeInt32LE(buf.length - 4, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

interface Packet { id: number; type: number; body: string }

/** Run the commands in order over one connection; resolves with every reply, rejects on auth or transport errors. */
export function rconExec(opts: RconOptions, commands: readonly string[]): Promise<RconReply[]> {
  // Idle timeout. `ce reload all` rebuilds and uploads CraftEngine's resource pack and prints nothing until done.
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise<RconReply[]>((resolve, reject) => {
    const socket = new Socket();
    let buffer = Buffer.alloc(0);
    const queue: Packet[] = [];
    let waiter: (() => void) | null = null;
    let done = false;
    const fail = (e: Error) => { if (done) return; done = true; socket.destroy(); reject(e); };
    const finish = (v: RconReply[]) => { if (done) return; done = true; socket.end(); resolve(v); };

    socket.setTimeout(timeoutMs, () => fail(new RconError(`rcon ${opts.host}:${opts.port}: timeout after ${timeoutMs} ms`)));
    socket.on("error", (e) => fail(new RconError(`rcon ${opts.host}:${opts.port}: ${e.message}`)));
    socket.on("close", () => fail(new RconError(`rcon ${opts.host}:${opts.port}: connection closed`)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32LE(0);
        if (buffer.length < 4 + len) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + len - 2).toString("utf8");
        buffer = buffer.subarray(4 + len);
        queue.push({ id, type, body });
      }
      if (waiter) { const w = waiter; waiter = null; w(); }
    });

    const next = (): Promise<Packet> => new Promise((res) => {
      const take = () => { const p = queue.shift(); if (p) res(p); else waiter = take; };
      take();
    });
    /** Wait briefly for more fragments of the same reply. */
    const more = (ms: number): Promise<Packet | null> => new Promise((res) => {
      if (queue.length) return res(queue.shift()!);
      const t = setTimeout(() => { waiter = null; res(null); }, ms);
      waiter = () => { clearTimeout(t); res(queue.shift() ?? null); };
    });

    socket.connect(opts.port, opts.host, async () => {
      try {
        socket.write(encodeRconPacket(1, AUTH, opts.password));
        let auth = await next();
        while (auth.type !== AUTH_RESPONSE) auth = await next(); // some servers send an empty type-0 packet first
        if (auth.id === -1) throw new RconError(`rcon ${opts.host}:${opts.port}: authentication failed`);
        const replies: RconReply[] = [];
        let id = 2;
        for (const command of commands) {
          const myId = id++;
          socket.write(encodeRconPacket(myId, EXEC, command));
          let p = await next();
          while (p.id !== myId || p.type !== RESPONSE) p = await next();
          let response = p.body;
          for (let extra = await more(150); extra; extra = await more(150)) if (extra.id === myId) response += extra.body;
          replies.push({ command, response });
        }
        finish(replies);
      } catch (e) {
        fail(e instanceof Error ? e : new RconError(String(e)));
      }
    });
  });
}
