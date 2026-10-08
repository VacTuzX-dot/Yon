import { expect, test } from "bun:test";
import { RelayTransport, decodeReply, encodeRequest, relayWsUrl } from "./transport";

test("request frames carry id, head and body", () => {
  const f = encodeRequest(7, "POST", "/pull?o=1&f=0&i=2", [["X-Yon-Ctr", "5"]], new Uint8Array([9, 8]));
  const v = new DataView(f.buffer);
  expect(v.getUint32(0)).toBe(7);
  const len = v.getUint16(4);
  expect(JSON.parse(new TextDecoder().decode(f.subarray(6, 6 + len)))).toEqual({
    m: "POST",
    t: "/pull?o=1&f=0&i=2",
    h: [["X-Yon-Ctr", "5"]],
  });
  expect([...f.subarray(6 + len)]).toEqual([9, 8]);
});

test("reply frames decode, headers case-insensitive", () => {
  const head = new TextEncoder().encode(JSON.stringify({ s: 200, h: [["x-yon-ctr", "3"]] }));
  const f = new Uint8Array(6 + head.length + 2);
  new DataView(f.buffer).setUint32(0, 42);
  new DataView(f.buffer).setUint16(4, head.length);
  f.set(head, 6);
  f.set([1, 2], 6 + head.length);
  const { id, reply } = decodeReply(f);
  expect(id).toBe(42);
  expect(reply.status).toBe(200);
  expect(reply.header("X-Yon-Ctr")).toBe("3");
  expect([...reply.body]).toEqual([1, 2]);
  expect(() => decodeReply(new Uint8Array([0, 0, 0, 1, 0, 2, 123, 125]))).toThrow();
});

test("relay addresses: wss everywhere but localhost", () => {
  expect(relayWsUrl("relay.example.com", "ab")).toBe("wss://relay.example.com/phone/ab");
  expect(relayWsUrl("localhost:8787", "ab")).toBe("ws://localhost:8787/phone/ab");
});

test("close() drops the socket and fails the request in flight", async () => {
  let onReceived!: () => void;
  const received = new Promise<void>((r) => (onReceived = r));
  let onServerClosed!: () => void;
  const serverClosed = new Promise<void>((r) => (onServerClosed = r));
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message: () => onReceived(), // the request arrived; never reply
      close: () => onServerClosed(),
    },
  });
  try {
    const t = new RelayTransport(`ws://localhost:${server.port}/phone/ab`);
    const outcome = t
      .send("POST", "/request", [], new Uint8Array([1]))
      .then(() => "replied", (e: Error) => e.message);
    await received;
    t.close();
    expect(await outcome).toBe("relay connection lost");
    await serverClosed;
  } finally {
    server.stop(true);
  }
});
