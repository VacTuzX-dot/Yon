// How the page's (already sealed) requests reach the computer: directly over
// the LAN with fetch, or through the Yon relay (ADR-003) over a WebSocket.
// Frame format matches src-tauri/src/link/remote.rs (minus the phone id,
// which the relay adds and strips).

export type Reply = { status: number; header(name: string): string | null; body: Uint8Array };

export interface Transport {
  send(method: string, target: string, headers: [string, string][], body: Uint8Array, signal?: AbortSignal): Promise<Reply>;
  /** Drop an open connection now; the next send reconnects. */
  close?(): void;
}

export const direct: Transport = {
  async send(method, target, headers, body, signal) {
    const res = await fetch(target, {
      method,
      headers,
      body: method === "GET" ? undefined : (body as Uint8Array<ArrayBuffer>),
      cache: "no-store",
      signal,
    });
    return {
      status: res.status,
      header: (n) => res.headers.get(n),
      body: new Uint8Array(await res.arrayBuffer()),
    };
  },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** request id u32 ‖ head length u16 ‖ head JSON ‖ body */
export function encodeRequest(id: number, method: string, target: string, headers: [string, string][], body: Uint8Array) {
  const head = enc.encode(JSON.stringify({ m: method, t: target, h: headers }));
  const out = new Uint8Array(6 + head.length + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, id);
  v.setUint16(4, head.length);
  out.set(head, 6);
  out.set(body, 6 + head.length);
  return out;
}

export function decodeReply(frame: Uint8Array): { id: number; reply: Reply } {
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const len = v.getUint16(4);
  const head = JSON.parse(dec.decode(frame.subarray(6, 6 + len))) as { s: number; h: [string, string][] };
  if (!Number.isInteger(head.s) || !Array.isArray(head.h)) throw new Error("bad reply");
  const headers = new Map(head.h.map(([k, val]) => [k.toLowerCase(), val]));
  return {
    id: v.getUint32(0),
    reply: { status: head.s, header: (n) => headers.get(n.toLowerCase()) ?? null, body: frame.subarray(6 + len) },
  };
}

/** Relay address from the pairing link: localhost is plain ws:// (testing). */
export function relayWsUrl(host: string, room: string): string {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "ws" : "wss"}://${host}/phone/${room}`;
}

const REPLY_TIMEOUT_MS = 60_000; // longer than the computer's 20 s long-poll

export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, { ok: (r: Reply) => void; fail: (e: Error) => void }>();

  constructor(private readonly url: string) {}

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => ws.close(), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        this.opening = null;
        resolve(ws);
      };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        try {
          const { id, reply } = decodeReply(new Uint8Array(e.data));
          this.pending.get(id)?.ok(reply);
          this.pending.delete(id);
        } catch {
          // malformed frame: ignore; its request times out
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        this.opening = null;
        // WHY: TypeError like a failed fetch, so the page's retry logic treats
        // a dropped relay connection as a network error.
        const err = new TypeError("relay connection lost");
        for (const p of this.pending.values()) p.fail(err);
        this.pending.clear();
        reject(err);
      };
    });
    return this.opening;
  }

  /** Closing fires onclose, which fails the requests in flight with a TypeError. */
  close(): void {
    this.ws?.close();
  }

  async send(method: string, target: string, headers: [string, string][], body: Uint8Array, signal?: AbortSignal) {
    const ws = await this.connect();
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => (done(), reject(new TypeError("relay timed out"))), REPLY_TIMEOUT_MS);
      signal?.addEventListener("abort", () => (done(), reject(new DOMException("aborted", "AbortError"))));
      this.pending.set(id, {
        ok: (r) => (done(), resolve(r)),
        fail: (e) => (done(), reject(e)),
      });
      ws.send(encodeRequest(id, method, target, headers, body));
    });
  }
}
