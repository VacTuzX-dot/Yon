// End-to-end check of a deployed relay, through whatever proxy/tunnel sits in
// front of it: WebSocket upgrade on /computer and /phone/<room>, room proof,
// and a 1 MiB frame each way (the size Yon Link chunks use).
//
//   bun relay/check.ts wss://relay.example.com
import { roomOf } from "./relay";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^wss?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base)) {
  console.error("usage: bun relay/check.ts wss://relay.example.com");
  process.exit(2);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const open = (url: string) =>
  new Promise<WebSocket>((ok, fail) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => fail(new Error(`no upgrade within 10 s: ${url}`)), 10_000);
    ws.onopen = () => (clearTimeout(t), ok(ws));
    ws.onerror = () => (clearTimeout(t), fail(new Error(`upgrade failed: ${url}`)));
  });
const next = (ws: WebSocket) =>
  new Promise<string | ArrayBuffer>((ok, fail) => {
    const t = setTimeout(() => fail(new Error("no message within 10 s")), 10_000);
    ws.onmessage = (e) => (clearTimeout(t), ok(e.data));
    ws.onclose = (e) => (clearTimeout(t), fail(new Error(`closed ${e.code} ${e.reason}`)));
  });
const step = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try {
    const r = await f();
    console.log(`ok   ${name} (${Math.round(performance.now() - t0)} ms)`);
    return r;
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message}`);
    process.exit(1);
  }
};

const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
const room = roomOf(secret);
const payload = crypto.getRandomValues(new Uint8Array(1024 * 1024));

const computer = await step("upgrade /computer", () => open(`${base}/computer`));
await step("room confirmed", async () => {
  computer.send(secret);
  if ((await next(computer)) !== room) throw new Error("relay confirmed a different room");
});
const phone = await step("upgrade /phone/<room>", () => open(`${base}/phone/${room}`));
await step("1 MiB phone → computer → phone", async () => {
  const got = next(computer);
  phone.send(payload);
  const f = new Uint8Array((await got) as ArrayBuffer);
  if (f.length !== 4 + payload.length || hex(f.subarray(4)) !== hex(payload)) throw new Error("frame changed");
  // Echo back with the phone id the relay added.
  const reply = next(phone);
  computer.send(f);
  const r = new Uint8Array((await reply) as ArrayBuffer);
  if (hex(r) !== hex(payload)) throw new Error("reply changed");
});
await step("unknown room refused", async () => {
  const other = roomOf(hex(crypto.getRandomValues(new Uint8Array(32))));
  const ws = await open(`${base}/phone/${other}`).catch(() => null);
  if (ws) throw new Error("relay accepted a phone for a room with no computer");
});
phone.close();
computer.close();
console.log("relay OK");
