import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { CLOSE, DEFAULT_LIMITS, type Limits, roomOf, startRelay } from "./relay";

const SECRET = "ab".repeat(32);
const OTHER = "cd".repeat(32);
let server: Server | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

function start(limits: Partial<Limits> = {}) {
  server = startRelay(0, { ...DEFAULT_LIMITS, ...limits });
  return `ws://127.0.0.1:${server.port}`;
}

/** A WebSocket with a queue of received messages and its close code. */
function client(url: string) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const inbox: (string | Uint8Array)[] = [];
  let waiting: (() => void) | null = null;
  let closed: number | null = null;
  ws.onmessage = (e) => {
    inbox.push(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    waiting?.();
  };
  ws.onclose = (e) => {
    closed = e.code;
    waiting?.();
  };
  const until = async (ok: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise<void>((r) => {
        waiting = r;
        setTimeout(r, 50);
      });
    }
  };
  return {
    ws,
    opened: () => new Promise<void>((r, j) => ((ws.onopen = () => r()), (ws.onerror = () => j(new Error("error"))))),
    next: async () => (await until(() => inbox.length > 0), inbox.shift()!),
    closedWith: async () => (await until(() => closed !== null), closed),
  };
}

async function computer(base: string, secret = SECRET) {
  const c = client(`${base}/computer`);
  await c.opened();
  c.ws.send(secret);
  expect(await c.next()).toBe(roomOf(secret)); // confirmation
  return c;
}

async function phone(base: string, room = roomOf(SECRET)) {
  const p = client(`${base}/phone/${room}`);
  await p.opened();
  return p;
}

const bytes = (...b: number[]) => new Uint8Array(b);

test("forwards frames between phones and their computer, tagged by phone", async () => {
  const base = start();
  const c = await computer(base);
  const p1 = await phone(base);
  const p2 = await phone(base);

  p1.ws.send(bytes(1, 2, 3));
  p2.ws.send(bytes(9));
  const f1 = (await c.next()) as Uint8Array;
  const f2 = (await c.next()) as Uint8Array;
  const id1 = new DataView(f1.buffer).getUint32(0);
  const id2 = new DataView(f2.buffer).getUint32(0);
  expect([...f1.subarray(4)]).toEqual([1, 2, 3]);
  expect([...f2.subarray(4)]).toEqual([9]);
  expect(id1).not.toBe(id2);

  // Reply to phone 2 only.
  const reply = new Uint8Array(6);
  new DataView(reply.buffer).setUint32(0, id2);
  reply.set([7, 7], 4);
  c.ws.send(reply);
  expect([...((await p2.next()) as Uint8Array)]).toEqual([7, 7]);
});

test("rooms are separate and need the computer online", async () => {
  const base = start();
  const res = await fetch(`${base.replace("ws", "http")}/phone/${roomOf(SECRET)}`);
  expect(res.status).toBe(404); // no computer yet
  await computer(base, OTHER);
  const res2 = await fetch(`${base.replace("ws", "http")}/phone/${roomOf(SECRET)}`);
  expect(res2.status).toBe(404); // another computer's room doesn't help
});

test("computer must prove the room secret quickly", async () => {
  const base = start({ authMs: 200 });
  const silent = client(`${base}/computer`);
  await silent.opened();
  expect(await silent.closedWith()).toBe(CLOSE.badAuth);

  const bad = client(`${base}/computer`);
  await bad.opened();
  bad.ws.send("not-a-secret");
  expect(await bad.closedWith()).toBe(CLOSE.badAuth);
});

test("a reconnecting computer replaces the old one and its phones", async () => {
  const base = start();
  const old = await computer(base);
  const p = await phone(base);
  await computer(base); // same secret
  expect(await old.closedWith()).toBe(CLOSE.replaced);
  expect(await p.closedWith()).toBe(CLOSE.replaced);
});

test("phones are dropped when their computer leaves", async () => {
  const base = start();
  const c = await computer(base);
  const p = await phone(base);
  c.ws.close();
  expect(await p.closedWith()).toBe(CLOSE.noComputer);
});

test("limits: frame size, bandwidth, connections per IP", async () => {
  const base = start({ maxFrame: 1024, bytesPerSecond: 3000, perIp: 3 });
  const c = await computer(base);
  const big = await phone(base);
  big.ws.send(new Uint8Array(2048));
  expect([1006, 1009]).toContain((await big.closedWith())!); // Bun drops oversize frames hard

  const fast = await phone(base);
  for (let i = 0; i < 4; i++) fast.ws.send(new Uint8Array(1000));
  expect(await fast.closedWith()).toBe(CLOSE.tooFast);

  await phone(base);
  await phone(base); // c + 2 phones = 3 from this IP
  const res = await fetch(`${base.replace("ws", "http")}/phone/${roomOf(SECRET)}`);
  expect(res.status).toBe(429);
  c.ws.close();
});
