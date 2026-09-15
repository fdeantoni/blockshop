import { createServer, type Socket } from "node:net";
import { encodeRconPacket } from "../src/rcon.js";

export interface FakeRcon { port: number; commands: string[]; close: () => Promise<void> }

/** A Source-RCON server that checks the password and answers `ok: <command>` (split in two packets when asked). */
export function startFakeRcon(password: string, opts: { split?: boolean; respond?: (command: string) => string } = {}): Promise<FakeRcon> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32LE(0);
        if (buffer.length < 4 + len) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + len - 2).toString("utf8");
        buffer = buffer.subarray(4 + len);
        if (type === 3) {
          socket.write(encodeRconPacket(body === password ? id : -1, 2, ""));
        } else if (type === 2) {
          commands.push(body);
          if (opts.split) { socket.write(encodeRconPacket(id, 0, "ok: ")); setTimeout(() => socket.write(encodeRconPacket(id, 0, body)), 20); }
          else socket.write(encodeRconPacket(id, 0, opts.respond ? opts.respond(body) : `ok: ${body}`));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port, commands,
        close: () => new Promise((res) => { for (const s of sockets) s.destroy(); server.close(() => res()); }),
      });
    });
  });
}
