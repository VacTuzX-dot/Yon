// Yon Link relay (ADR-003): forwards sealed Yon Link frames between phones and
// the computer that serves a room. It can't read them (AEAD with the phone's
// session key) and stores nothing.
//
// - Computer: WebSocket to /computer, first message = room secret R (64 hex).
//   It then serves room SHA-256(R). A new connection with the same R replaces
//   the old one (reconnects after sleep/network changes).
// - Phone: WebSocket to /phone/<room id>. Binary frames only.
// - Frames to/from the computer carry a 4-byte big-endian phone connection id
//   in front, so one computer socket serves many phones.
import type { Server, ServerWebSocket } from "bun";

export interface Limits {
  maxFrame: number; // bytes per WebSocket message
  bytesPerSecond: number; // per connection, averaged over one second
  perIp: number; // open connections per client IP (IPv6: per /64)
  /** Computer connections per client IP (IPv6: per /64), authenticated or
   *  not. Rooms are capped globally; this keeps one host from filling them. */
  computersPerIp: number;
  phonesPerRoom: number;
  rooms: number;
  authMs: number; // computer must send its secret within this
  idleSeconds: number;
  /** Behind Cloudflare: take the client IP from CF-Connecting-IP. */
  trustCloudflare: boolean;
}

export const DEFAULT_LIMITS: Limits = {
  maxFrame: (1 << 20) + 4096, // one 1 MiB Yon Link chunk + headers + id
  bytesPerSecond: 64 << 20,
  perIp: 16,
  computersPerIp: 4,
  phonesPerRoom: 32,
  rooms: 2000,
  authMs: 5000,
  idleSeconds: 60,
  trustCloudflare: false,
};

type Data = {
  role: "computer" | "phone";
  ip: string;
  room: string | null;
  id: number;
  windowStart: number;
  windowBytes: number;
  authTimer?: ReturnType<typeof setTimeout>;
};
type Socket = ServerWebSocket<Data>;
type Room = { computer: Socket; phones: Map<number, Socket> };

export const CLOSE = {
  badAuth: 4000,
  replaced: 4001,
  noComputer: 4004,
  tooFast: 4008,
  full: 4009,
} as const;

const HEX64 = /^[0-9a-f]{64}$/;

/** Key for per-address limits. IPv6 is grouped by /64: one home or VPS
 *  gets a whole /64, so per-address counting would be no limit at all. */
export function limitKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Room id = SHA-256 of the 32 secret bytes, hex. */
export function roomOf(secretHex: string): string {
  return new Bun.CryptoHasher("sha256").update(Buffer.from(secretHex, "hex")).digest("hex");
}

export function startRelay(port: number, limits: Limits = DEFAULT_LIMITS): Server {
  const rooms = new Map<string, Room>();
  const perIp = new Map<string, number>();
  const computersPerIp = new Map<string, number>();
  let nextPhone = 1;

  const overLimit = (ws: Socket, n: number): boolean => {
    const now = Date.now();
    if (now - ws.data.windowStart >= 1000) {
      ws.data.windowStart = now;
      ws.data.windowBytes = 0;
    }
    ws.data.windowBytes += n;
    return ws.data.windowBytes > limits.bytesPerSecond;
  };

  const closeRoom = (room: string, code: number, reason: string) => {
    const r = rooms.get(room);
    if (!r) return;
    rooms.delete(room);
    for (const p of r.phones.values()) p.close(code, reason);
  };

  return Bun.serve<Data, never>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      const ip = limitKey(
        (limits.trustCloudflare && req.headers.get("cf-connecting-ip")) ||
          server.requestIP(req)?.address ||
          "?",
      );
      if ((perIp.get(ip) ?? 0) >= limits.perIp) return new Response("Too many connections", { status: 429 });
      const base = { ip, room: null, id: 0, windowStart: Date.now(), windowBytes: 0 };

      if (url.pathname === "/computer") {
        if (rooms.size >= limits.rooms) return new Response("Full", { status: 503 });
        if ((computersPerIp.get(ip) ?? 0) >= limits.computersPerIp) {
          return new Response("Too many computers", { status: 429 });
        }
        if (server.upgrade(req, { data: { ...base, role: "computer" } })) return;
        return new Response("WebSocket only", { status: 426 });
      }
      const m = /^\/phone\/([0-9a-f]{64})$/.exec(url.pathname);
      if (m) {
        const room = rooms.get(m[1]);
        // WHY: same answer for "no such room" and "computer offline".
        if (!room) return new Response("Computer offline", { status: 404 });
        if (room.phones.size >= limits.phonesPerRoom) return new Response("Full", { status: 503 });
        if (server.upgrade(req, { data: { ...base, role: "phone", room: m[1], id: nextPhone++ } })) return;
        return new Response("WebSocket only", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: limits.maxFrame,
      idleTimeout: limits.idleSeconds,
      closeOnBackpressureLimit: true,
      open(ws) {
        perIp.set(ws.data.ip, (perIp.get(ws.data.ip) ?? 0) + 1);
        if (ws.data.role === "computer") {
          computersPerIp.set(ws.data.ip, (computersPerIp.get(ws.data.ip) ?? 0) + 1);
          ws.data.authTimer = setTimeout(() => ws.close(CLOSE.badAuth, "no secret"), limits.authMs);
          return;
        }
        const room = rooms.get(ws.data.room!);
        if (!room) return ws.close(CLOSE.noComputer, "computer offline");
        room.phones.set(ws.data.id, ws);
      },
      message(ws, msg) {
        const size = typeof msg === "string" ? msg.length : msg.byteLength;
        if (overLimit(ws, size)) return ws.close(CLOSE.tooFast, "slow down");

        if (ws.data.role === "computer" && ws.data.room === null) {
          clearTimeout(ws.data.authTimer);
          if (typeof msg !== "string" || !HEX64.test(msg)) return ws.close(CLOSE.badAuth, "bad secret");
          const room = roomOf(msg);
          const old = rooms.get(room);
          if (old) {
            // WHY: room first — Bun runs the old socket's close handler inside
            // close(), which would otherwise report "computer offline".
            closeRoom(room, CLOSE.replaced, "computer reconnected");
            old.computer.close(CLOSE.replaced, "replaced");
          }
          ws.data.room = room;
          rooms.set(room, { computer: ws, phones: new Map() });
          ws.send(room); // confirms the room id the computer serves
          return;
        }
        if (typeof msg === "string") return; // only binary frames are forwarded

        const room = rooms.get(ws.data.room!);
        if (!room) return ws.close(CLOSE.noComputer, "computer offline");
        if (ws.data.role === "phone") {
          const frame = new Uint8Array(4 + msg.byteLength);
          new DataView(frame.buffer).setUint32(0, ws.data.id);
          frame.set(msg, 4);
          room.computer.send(frame);
        } else if (msg.byteLength >= 4) {
          const id = new DataView(msg.buffer, msg.byteOffset).getUint32(0);
          room.phones.get(id)?.send(msg.subarray(4));
        }
      },
      close(ws) {
        clearTimeout(ws.data.authTimer);
        const left = (perIp.get(ws.data.ip) ?? 1) - 1;
        if (left > 0) perIp.set(ws.data.ip, left);
        else perIp.delete(ws.data.ip);
        if (ws.data.role === "computer") {
          const c = (computersPerIp.get(ws.data.ip) ?? 1) - 1;
          if (c > 0) computersPerIp.set(ws.data.ip, c);
          else computersPerIp.delete(ws.data.ip);
        }
        const room = ws.data.room && rooms.get(ws.data.room);
        if (!room) return;
        if (ws.data.role === "phone") room.phones.delete(ws.data.id);
        else if (room.computer === ws) closeRoom(ws.data.room!, CLOSE.noComputer, "computer offline");
      },
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const server = startRelay(port, { ...DEFAULT_LIMITS, trustCloudflare: process.env.TRUST_CLOUDFLARE === "1" });
  console.log(`Yon relay listening on :${server.port}`);
}
