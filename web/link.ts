// Yon Link phone page: pair once (QR → URL fragment), then send files to the
// computer and receive files from it over sealed requests. One Home Screen icon
// reaches every paired computer (keyring: web/keyring.ts, spec "Phone page").
// Protocol: src-tauri/src/link/mod.rs (upload) and link/outbox.rs (download).
// Every text shown here goes through textContent, never innerHTML.
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { COMPUTER_TO_PHONE, PHONE_TO_COMPUTER, ReplayWindow, deriveKey, open, seal } from "./crypto";
import { MAX_COMPUTERS, addComputer, forgetComputer, loadComputers, parseScanned, type Pairing } from "./keyring";
import { canScan, scanQr } from "./scan";
import { RelayTransport, direct, relayWsUrl, type Transport } from "./transport";

type Reply = { result: string; reason?: string; file?: number; next?: number; chunk?: number };
type Offer = {
  id: number;
  from: string;
  files: { name: string; size: number }[];
  total: number;
  chunk: number;
};

/** The session or the pairing no longer exists on the computer (404). */
class Gone extends Error {}

const MAX_RETRIES = 20;
/** Pair id of the computer the last accepted send went through. */
const LAST_KEY = "yon-link-last";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keys and transport for one pairing. */
type Keys = { p: Uint8Array; k: Uint8Array; transport: Transport };

/** One paired computer and its state on this page. */
type Computer = {
  pairing: Pairing; // as stored in the keyring
  conn: Keys;
  name: string; // "" until the computer has answered /hello
  listener: Session | null;
  state: "connecting" | "online" | "offline" | "gone";
};

/** localStorage, or null when the browser blocks it (private mode). */
function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** `<pair id>.<key>` on the LAN, or `<pair id>.<key>.<room>@<relay host>` to reach
 * the computer from anywhere through the relay (ADR-003). `raw` is already
 * lowercase and checked by parsePairing. */
function connOf(raw: string): Keys {
  const [head, host] = raw.split("@");
  const [p, k, room] = head.split(".");
  return {
    p: hexToBytes(p),
    k: hexToBytes(k),
    transport: host ? new RelayTransport(relayWsUrl(host, room)) : direct,
  };
}

class Session {
  private ctr = 0n;
  private replies = new ReplayWindow();
  private inflight: AbortController | null = null;

  private constructor(
    private readonly sid: Uint8Array,
    private readonly key: Uint8Array,
    readonly computer: string,
    private readonly transport: Transport,
  ) {}

  static async start({ p, k, transport }: Keys): Promise<Session> {
    const nc = crypto.getRandomValues(new Uint8Array(16));
    const res = await transport.send("GET", `/hello?p=${bytesToHex(p)}&nc=${bytesToHex(nc)}`, [], new Uint8Array());
    if (res.status === 404) throw new Gone();
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const v = JSON.parse(new TextDecoder().decode(res.body));
    const hex32 = /^[0-9a-f]{32}$/;
    if (!hex32.test(v?.sid) || !hex32.test(v?.ns) || typeof v?.name !== "string") {
      throw new Error("bad hello");
    }
    const ns = hexToBytes(v.ns);
    return new Session(hexToBytes(v.sid), deriveKey(k, ns, nc), v.name, transport);
  }

  /** One sealed POST, JSON reply. */
  async call(target: string, body: Uint8Array = new Uint8Array()): Promise<Reply> {
    this.inflight = new AbortController();
    const plain = await this.request(target, body, this.inflight.signal);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /** One sealed POST, raw reply. A fresh counter per attempt, so retries are
   * never replays; several may run at once. */
  async request(target: string, body: Uint8Array = new Uint8Array(), signal?: AbortSignal): Promise<Uint8Array> {
    const ctr = ++this.ctr;
    const route = `POST ${target}`;
    const headers: [string, string][] = [
      ["X-Yon-Sid", bytesToHex(this.sid)],
      ["X-Yon-Ctr", ctr.toString()],
    ];
    const sealedBody = seal(this.key, PHONE_TO_COMPUTER, ctr, route, this.sid, body);
    const res = await this.transport.send("POST", target, headers, sealedBody, signal);
    if (res.status === 404) throw new Gone();
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const out = BigInt(res.header("X-Yon-Ctr") ?? "0");
    // Replies to parallel requests may arrive out of order; each only once.
    if (!this.replies.isFresh(out)) throw new Error("stale reply");
    const plain = open(this.key, COMPUTER_TO_PHONE, out, route, this.sid, res.body);
    this.replies.mark(out);
    return plain;
  }

  abort() {
    this.inflight?.abort();
  }
}

// ---- UI ----

const ui = {
  subtitle: el("subtitle"),
  pick: el("pick"),
  choose: el("choose"),
  targets: el("targets"),
  chooseCancel: el<HTMLButtonElement>("choose-cancel"),
  incoming: el("incoming"),
  offerText: el("offer-text"),
  offerFiles: el("offer-files"),
  receive: el<HTMLButtonElement>("receive"),
  decline: el<HTMLButtonElement>("decline"),
  saved: el("saved"),
  saveHint: el("save-hint"),
  input: el<HTMLInputElement>("files"),
  actions: el("actions"),
  addComputer: el<HTMLButtonElement>("add-computer"),
  manage: el<HTMLButtonElement>("manage"),
  computers: el("computers"),
  computerList: el<HTMLUListElement>("computer-list"),
  computersDone: el<HTMLButtonElement>("computers-done"),
  busy: el("busy"),
  status: el("status"),
  fill: el("fill"),
  detail: el("detail"),
  cancel: el<HTMLButtonElement>("cancel"),
  end: el("end"),
  result: el("result"),
  again: el<HTMLButtonElement>("again"),
};

function show(section: HTMLElement) {
  for (const s of [ui.pick, ui.choose, ui.incoming, ui.busy, ui.end, ui.computers]) s.hidden = s !== section;
  // WHY: a header button would cover the transfer or offer screen while it runs on.
  ui.actions.hidden = section === ui.busy || section === ui.incoming;
}

function finish(text: string, tone: "ok" | "bad", button: string, action: () => void) {
  ui.saved.hidden = ui.saveHint.hidden = true;
  ui.result.textContent = text;
  ui.result.className = tone;
  ui.again.textContent = button;
  ui.again.onclick = action;
  show(ui.end);
}

function progress(done: number, total: number) {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
  ui.fill.style.width = `${pct}%`; // CSSOM, allowed under style-src 'self'
  ui.detail.textContent = `${formatBytes(done)} of ${formatBytes(total)}`;
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function whenVisible(): Promise<void> {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/** The computers this phone reaches. Set once in init. */
let computers: Computer[] = [];

/** How a computer is named in messages before its /hello has answered. */
const nameOf = (c: Computer) => c.name || "your computer";

/** "Can't reach" text. Wi-Fi only matters for a LAN pairing; a relay pairing needs Reach from anywhere. */
function unreachable(c: Computer, name = nameOf(c)): string {
  return c.pairing.relay
    ? `Can't reach ${name}. Check that Yon is open on it and Reach from anywhere is on.`
    : `Can't reach ${name}. Check that it's on the same Wi-Fi and Yon is open.`;
}

// ---- Sending ----

let current: { session: Session; cancelled: boolean } | null = null;

/** Retry network hiccups (and iOS suspending a hidden page) on the same session. */
async function retrying<T>(job: { cancelled: boolean }, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (job.cancelled || e instanceof Gone || attempt >= MAX_RETRIES) throw e;
      ui.detail.textContent = "Connection lost. Retrying…";
      await whenVisible();
      await sleep(Math.min(attempt * 1000, 5000));
    }
  }
}

/** Another paired phone with Yon open; the computer relays to it. */
type Target = { id: string; name: string };

async function send(files: File[], c: Computer, to?: Target) {
  if (files.length === 0) return;
  ui.status.textContent = "Connecting…";
  ui.detail.textContent = "";
  ui.fill.style.width = "0%";
  ui.cancel.hidden = false;
  show(ui.busy);

  let job: { session: Session; cancelled: boolean } | null = null;
  try {
    const session = await Session.start(c.conn);
    job = current = { session, cancelled: false };
    c.name = session.computer;
    const dest = to?.name ?? c.name;

    ui.status.textContent = to ? `Sending to ${dest}…` : `Waiting for ${c.name} to accept…`;
    const meta = files.map((f) => ({ name: f.name, size: f.size }));
    const body = to ? { files: meta, to: to.id } : { files: meta };
    const answer = await session.call("/request", utf8ToBytes(JSON.stringify(body)));
    if (answer.result !== "accepted") return refused(answer, dest, c);
    rememberLast(c);

    const chunk = answer.chunk ?? 1 << 20;
    const total = files.reduce((n, f) => n + f.size, 0);
    const before = (f: number) => files.slice(0, f).reduce((n, x) => n + x.size, 0);
    ui.status.textContent =
      files.length === 1 ? `Sending ${files[0].name} to ${dest}` : `Sending ${files.length} files to ${dest}`;

    let f = 0;
    let i = 0;
    for (;;) {
      while (f < files.length) {
        const file = files[f];
        progress(before(f) + Math.min(i * chunk, file.size), total);
        const start = i * chunk;
        const data = new Uint8Array(await file.slice(start, start + chunk).arrayBuffer());
        const r = await retrying(job, () => session.call(`/chunk?f=${f}&i=${i}`, data));
        if (r.result !== "ok" && r.result !== "resume") return stopped(r, c);
        // WHY: always continue from the computer's position; it is the only
        // side that knows what was written (a lost reply looks like a failure here).
        if (!Number.isSafeInteger(r.file) || !Number.isSafeInteger(r.next) || r.file! > files.length) {
          throw new Error("bad position");
        }
        f = r.file!;
        i = r.next!;
        ui.detail.textContent = "";
      }
      progress(total, total);
      const done = await retrying(job, () => session.call("/done"));
      if (done.result === "completed") break;
      if (done.result !== "resume" || !Number.isSafeInteger(done.file) || !Number.isSafeInteger(done.next)) {
        return stopped(done, c);
      }
      f = done.file!;
      i = done.next!;
    }
    const n = files.length === 1 ? "1 file" : `${files.length} files`;
    finish(
      to
        ? `Sent ${n}. ${dest} will be asked to receive ${files.length === 1 ? "it" : "them"}.`
        : `Sent ${n} to ${c.name}.`,
      "ok",
      "Send more",
      pickAgain,
    );
  } catch (e) {
    if (job?.cancelled) return;
    if (e instanceof Gone) {
      finish(
        job
          ? "Sending stopped: the connection was lost for too long. Send again."
          : "This phone isn't paired with the computer anymore. Pair it again from Yon's settings.",
        "bad",
        "Try again",
        pickAgain,
      );
    } else {
      finish(unreachable(c), "bad", "Try again", pickAgain);
    }
  } finally {
    if (current === job) current = null;
  }
}

function refused(r: Reply, dest: string, c: Computer) {
  const who = nameOf(c);
  const text: Record<string, string> = {
    declined: `${dest} declined.`,
    busy: `${who} is busy with another transfer. Try again in a moment.`,
    insufficient_space: `Not enough free space on ${who}.`,
    unavailable: `${dest} isn't available. Ask them to open Yon on their phone.`,
    too_big: "Phones can receive up to 1 GB at a time. Send fewer files.",
  };
  finish(text[r.result] ?? `Can't send: ${r.reason ?? r.result}.`, "bad", "Send something else", pickAgain);
}

function stopped(r: Reply, c: Computer) {
  const text =
    r.result === "cancelled"
      ? `Cancelled on ${nameOf(c)}.`
      : `Sending failed${r.reason ? `: ${r.reason}` : ""}. Files already sent were kept.`;
  finish(text, "bad", "Send again", pickAgain);
}

function pickAgain() {
  show(ui.pick);
}

/** Can this page scan a pairing? HTTPS only, storage to keep it, and a camera. */
const canAddComputer = () => location.protocol === "https:" && storage() !== null && canScan();

// ---- Receiving (computer → phone) ----

const standalone =
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** Parallel chunk requests: fills the Wi-Fi without much memory (spike: 1 → ~3× faster). */
const PULLS = 3;
let receiving: { cancelled: boolean } | null = null;

class Stop extends Error {
  constructor(readonly result: string) {
    super(result);
  }
}

function isOffer(o: unknown): o is Offer {
  const v = o as Offer;
  return (
    Number.isSafeInteger(v?.id) &&
    typeof v.from === "string" &&
    Array.isArray(v.files) &&
    v.files.length > 0 &&
    v.files.every((f) => typeof f?.name === "string" && Number.isSafeInteger(f.size) && f.size >= 0) &&
    Number.isSafeInteger(v.total) &&
    Number.isSafeInteger(v.chunk) &&
    v.chunk > 0 &&
    v.chunk <= 1 << 22
  );
}

/** The computer's listener session for /inbox and downloads; replaced when it expires. */
async function listenerSession(c: Computer): Promise<Session> {
  if (!c.listener) {
    c.listener = await Session.start(c.conn);
    c.name = c.listener.computer;
  }
  return c.listener;
}

/** Run with the listener session; if it expired (iOS suspended the page for
 * a while), start a new one and try again. Offers belong to the phone, so a
 * new session carries on where the old one stopped. */
async function withListener<T>(c: Computer, fn: (s: Session) => Promise<T>): Promise<T> {
  try {
    return await fn(await listenerSession(c));
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
    c.listener = null;
    return fn(await listenerSession(c));
  }
}

/** Ask one computer for offers while the page is visible and idle. One loop per computer. */
async function listen(c: Computer) {
  let backoff = 1000;
  for (;;) {
    await whenVisible();
    if (current || receiving || !ui.incoming.hidden) {
      await sleep(1000);
      continue;
    }
    try {
      const r = (await withListener(c, (s) => s.call("/inbox"))) as unknown as { offer: unknown };
      backoff = 1000;
      c.state = "online";
      // WHY: another computer may have shown an offer in the same poll window; a
      // skipped offer is not lost: /inbox returns it again on the next poll.
      if (r.offer && isOffer(r.offer) && !current && !receiving && ui.incoming.hidden) showOffer(c, r.offer);
    } catch (e) {
      c.listener = null;
      if (e instanceof Gone) {
        c.state = "gone"; // not paired any more: hello says 404
        return;
      }
      c.state = "offline";
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  }
}

function fileRow(name: string, size: number): HTMLLIElement {
  const li = document.createElement("li");
  const n = document.createElement("span");
  n.className = "name";
  n.textContent = name;
  const s = document.createElement("span");
  s.className = "size";
  s.textContent = formatBytes(size);
  li.append(n, s);
  return li;
}

function showOffer(c: Computer, o: Offer) {
  const n = o.files.length === 1 ? "a file" : `${o.files.length} files`;
  // WHY: with several computers, say which one the offer came through.
  const via = computers.length > 1 ? ` via ${c.name}` : "";
  ui.offerText.textContent = `${o.from} wants to send you ${n} (${formatBytes(o.total)})${via}.`;
  ui.offerFiles.replaceChildren(...o.files.slice(0, 5).map((f) => fileRow(f.name, f.size)));
  if (o.files.length > 5) ui.offerFiles.append(fileRow(`and ${o.files.length - 5} more`, o.total));
  ui.receive.onclick = () => void receive(c, o);
  ui.decline.onclick = () => {
    void withListener(c, (s) => s.call(`/offer/decline?o=${o.id}`)).catch(() => {});
    pickAgain();
  };
  show(ui.incoming);
}

const TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  pdf: "application/pdf", txt: "text/plain",
};

function typeFor(name: string): string {
  return TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** Hand a received file to the browser: Downloads in Safari, a viewer with
 * Share → Save when opened from the Home Screen. */
function save(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function pull(c: Computer, o: Offer, f: number, i: number): Promise<Uint8Array> {
  const plain = await withListener(c, (s) => s.request(`/pull?o=${o.id}&f=${f}&i=${i}`));
  if (plain[0] !== 0) {
    const r = JSON.parse(new TextDecoder().decode(plain.subarray(1))) as Reply;
    throw new Stop(r.result);
  }
  const size = o.files[f].size;
  const expected = Math.min(o.chunk, size - i * o.chunk);
  const data = plain.subarray(1);
  if (data.length !== Math.max(0, expected)) throw new Stop("failed");
  return data;
}

async function receive(c: Computer, o: Offer) {
  const job = { cancelled: false };
  receiving = job;
  ui.status.textContent = `Receiving from ${o.from}`;
  ui.detail.textContent = "";
  ui.fill.style.width = "0%";
  ui.cancel.hidden = false;
  ui.cancel.onclick = () => {
    job.cancelled = true;
    void withListener(c, (s) => s.call(`/offer/cancel?o=${o.id}`)).catch(() => {});
    finish("Cancelled.", "bad", "Done", pickAgain);
  };
  show(ui.busy);
  const received: { name: string; blob: Blob }[] = [];
  try {
    const ok = await withListener(c, (s) => s.call(`/offer/accept?o=${o.id}`));
    if (ok.result !== "accepted") throw new Stop(ok.result);
    let done = 0;
    for (let f = 0; f < o.files.length; f++) {
      const file = o.files[f];
      const count = Math.max(1, Math.ceil(file.size / o.chunk));
      // WHY: a Blob per chunk; one big array + Blob at the end needs twice
      // the memory and iOS closed the page at 1 GB (spike, 2026-09-27).
      const parts: Blob[] = new Array(count);
      let next = 0;
      const worker = async () => {
        while (next < count && !job.cancelled) {
          const i = next++;
          const data = await retrying(job, () => pull(c, o, f, i));
          parts[i] = new Blob([data as BlobPart]);
          done += data.length;
          progress(done, o.total);
        }
      };
      await Promise.all(Array.from({ length: PULLS }, worker));
      if (job.cancelled) return;
      const blob = new Blob(parts, { type: typeFor(file.name) });
      received.push({ name: file.name, blob });
      if (!standalone) save(file.name, blob);
    }
    const end = await withListener(c, (s) => s.call(`/offer/done?o=${o.id}`));
    if (end.result !== "completed") throw new Stop(end.result);
    const n = received.length === 1 ? "1 file" : `${received.length} files`;
    finish(`Received ${n} from ${o.from}.`, "ok", "Done", pickAgain);
    showSaved(received);
  } catch (e) {
    if (job.cancelled) return;
    const why =
      e instanceof Stop && e.result === "cancelled"
        ? `Cancelled on ${o.from}.`
        : e instanceof Stop && e.result === "none"
          ? `${o.from} withdrew the files.`
          : `Couldn't receive the files from ${o.from}. Try again from the computer.`;
    finish(why, "bad", "Done", pickAgain);
    if (received.length > 0) showSaved(received);
  } finally {
    if (receiving === job) receiving = null;
    ui.cancel.onclick = null; // the send flow has its own listener
  }
}

/** Saved files stay listed so they can be saved again (Home Screen mode
 * opens one file at a time). */
function showSaved(files: { name: string; blob: Blob }[]) {
  ui.saved.replaceChildren(
    ...files.map(({ name, blob }) => {
      const li = fileRow(name, blob.size);
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Save";
      b.onclick = () => save(name, blob);
      li.append(b);
      return li;
    }),
  );
  ui.saved.hidden = false;
  ui.saveHint.hidden = !standalone;
}

ui.input.addEventListener("change", () => {
  const files = Array.from(ui.input.files ?? []);
  ui.input.value = ""; // picking the same files again still fires `change`
  if (files.length > 0) void chooseTarget(files);
});

/** Other phones reachable through one computer; [] if they can't be listed. */
async function peersOf(c: Computer): Promise<Target[]> {
  try {
    const r = (await withListener(c, (s) => s.call("/peers"))) as unknown as { phones?: unknown };
    if (!Array.isArray(r.phones)) return [];
    return r.phones.filter(
      (p): p is Target => typeof p?.id === "string" && /^[0-9a-f]{16}$/.test(p.id) && typeof p?.name === "string",
    );
  } catch {
    // can't list phones: the computer is still a fine default
    return [];
  }
}

/** The computer used last (stored by id), if it is still in the list. */
function lastId(): string | null {
  try {
    const v = storage()?.getItem(LAST_KEY) ?? null;
    return v && /^[0-9a-f]{32}$/.test(v) && computers.some((c) => c.pairing.id === v) ? v : null;
  } catch {
    // storage blocked: no preference, keyring order
    return null;
  }
}

/** Remember the computer a send went through, so the chooser lists it first. */
function rememberLast(c: Computer) {
  try {
    // WHY: best effort; with storage blocked the chooser just keeps keyring order.
    storage()?.setItem(LAST_KEY, c.pairing.id);
  } catch {
    // storage blocked or full: nothing to remember
  }
}

/** Pick a computer, or another phone reached through one. With a single
 * computer and no other phones, straight to the computer. */
async function chooseTarget(files: File[]) {
  const reachable = computers.filter((c) => c.state !== "gone");
  // WHY: the computer used last comes first, so the common case is one tap.
  const last = lastId();
  const ordered = [
    ...reachable.filter((c) => c.pairing.id === last),
    ...reachable.filter((c) => c.pairing.id !== last),
  ];
  // Peers are only asked of computers that answer now.
  const groups = await Promise.all(
    ordered
      .filter((c) => c.state === "online")
      .map(async (c) => ({ c, phones: await peersOf(c) })),
  );
  const phoneCount = groups.reduce((n, g) => n + g.phones.length, 0);
  if (reachable.length <= 1 && phoneCount === 0) return void send(files, reachable[0] ?? computers[0]);

  const button = (label: string, go: () => void, offline = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = go;
    if (offline) {
      b.disabled = true;
      b.className = "offline";
    }
    return b;
  };
  const single = computers.length === 1;
  const buttons: HTMLButtonElement[] = ordered.map((c) =>
    c.state === "online"
      ? button(single ? `${c.name} (this computer)` : c.name, () => void send(files, c))
      : button(`${c.name || "Computer"} — can't reach it`, () => {}, true),
  );
  for (const { c, phones } of groups) {
    for (const p of phones) {
      buttons.push(button(single ? p.name : `${p.name} (via ${c.name})`, () => void send(files, c, p)));
    }
  }
  ui.targets.replaceChildren(...buttons);
  ui.chooseCancel.onclick = pickAgain;
  show(ui.choose);
  buttons.find((b) => !b.disabled)?.focus();
}

ui.cancel.addEventListener("click", () => {
  const job = current;
  if (!job || receiving) return;
  job.cancelled = true;
  job.session.abort();
  void job.session.call("/cancel").catch(() => {}); // best effort; the computer also times out
  finish("Cancelled.", "bad", "Send something else", pickAgain);
});

// ---- Computers: list, forget, add by scan ----

function stateText(c: Computer): string {
  switch (c.state) {
    case "online":
      return "Online";
    case "offline":
      return "Can't reach it";
    case "gone":
      return c.name
        ? `Removed on ${c.name} — this phone isn't paired anymore`
        : "Removed on the computer — this phone isn't paired anymore";
    default:
      return "Connecting…";
  }
}

function openComputers() {
  ui.computerList.replaceChildren(
    ...computers.map((c) => {
      const li = document.createElement("li");
      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("span");
      name.textContent = c.name || "Computer";
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = stateText(c);
      info.append(name, state);
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "forget";
      forget.textContent = "Forget";
      forget.onclick = () => {
        forgetComputer(storage(), c.pairing.id);
        location.reload();
      };
      li.append(info, forget);
      return li;
    }),
  );
  show(ui.computers);
}

const FULL_TEXT = "This phone can keep 4 computers. Forget one first.";
const CAMERA_DENIED =
  "Yon can't use the camera. Allow it in your browser settings, or scan the code with the Camera app and open the link.";

/** The screen with no computers yet: scan the first pairing. */
function showFirstScan() {
  ui.subtitle.textContent = "Scan the QR code in Yon on your computer (Settings → Phones → Pair a phone).";
  finish("", "ok", "Add computer", () => void addFromScan());
}

/** Back action: the pick screen, or the first-scan screen when there are no computers. */
function home() {
  if (computers.length === 0) showFirstScan();
  else pickAgain();
}

/** Scan a computer's pairing QR (Settings → Phones → Pair a phone) and keep that computer on this phone. */
async function addFromScan() {
  if (computers.length >= MAX_COMPUTERS) return finish(FULL_TEXT, "bad", "Back", home);

  let text: string;
  try {
    text = await scanQr();
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "AbortError") return home(); // Cancel in the scanner
    return finish(name === "NotAllowedError" ? CAMERA_DENIED : "Can't open the camera.", "bad", "Back", home);
  }

  const parsed = parseScanned(text, location);
  if (!parsed.ok) {
    return finish(
      parsed.reason === "lan"
        ? "That code only works on the same Wi-Fi. Turn on Reach from anywhere in Yon on that computer, then show the code again."
        : "This isn't a Yon pairing code.",
      "bad",
      "Back",
      home,
    );
  }
  switch (addComputer(storage(), parsed.pairing)) {
    case "added":
    case "exists":
      // WHY: a reload reads the keyring again, which starts the new computer's session.
      location.reload();
      return;
    case "full":
      return finish(FULL_TEXT, "bad", "Back", home);
    case "blocked":
      return finish("This browser can't keep another computer.", "bad", "Back", home);
  }
}

ui.addComputer.addEventListener("click", () => void addFromScan());
ui.manage.addEventListener("click", openComputers);
ui.computersDone.addEventListener("click", pickAgain);

// WHY: closing the socket frees the relay slot now (the relay allows 16 per IP);
// the transports reconnect on the next request.
window.addEventListener("pagehide", () => {
  for (const c of computers) c.conn.transport.close?.();
});

// ---- Start ----

async function init() {
  el("add-home").hidden = standalone;
  // WHY: the LAN page (http) is one computer per origin (spec Phase 2): only the
  // fragment pairing, which loadComputers puts first, not older stored ones.
  const saved = loadComputers(location.hash, storage());
  const list = location.protocol === "https:" ? saved : saved.slice(0, 1);
  computers = list.map((pairing) => ({
    pairing,
    conn: connOf(pairing.raw),
    name: "",
    listener: null,
    state: "connecting",
  }));
  if (computers.length === 0) {
    if (canAddComputer()) return showFirstScan();
    ui.subtitle.textContent = "Open this page by scanning the QR code in Yon on your computer (Settings → Phones).";
    return;
  }
  ui.manage.hidden = false;
  // WHY: scanning needs the HTTPS page (camera permission), local storage and a camera.
  ui.addComputer.hidden = !canAddComputer();

  const settled = await Promise.allSettled(computers.map((c) => listenerSession(c)));
  settled.forEach((r, i) => {
    const c = computers[i];
    if (r.status === "fulfilled") c.state = "online";
    else c.state = r.reason instanceof Gone ? "gone" : "offline";
  });
  // WHY: an offline computer is retried by its loop (backoff), so it can come
  // online later; only a "gone" one (not paired any more) has nothing to poll.
  for (const c of computers) if (c.state !== "gone") void listen(c);

  const online = computers.filter((c) => c.state === "online");
  if (online.length === 0) {
    if (computers.length > 1) {
      ui.subtitle.textContent = "Can't reach your computers. Check that Yon is open on them, then try again.";
    } else if (computers[0].state === "gone") {
      ui.subtitle.textContent = "This phone isn't paired with the computer anymore. Pair it again from Yon's settings.";
    } else {
      ui.subtitle.textContent = unreachable(computers[0], "the computer");
    }
    finish("", "bad", "Try again", () => location.reload());
    return;
  }
  el("title").textContent = computers.length === 1 ? `Send to ${computers[0].name}` : "Send with Yon";
  ui.subtitle.textContent = "Paired with Yon";
  show(ui.pick);
}

// A new QR scanned while this page is open only changes the fragment.
window.addEventListener("hashchange", () => location.reload());

void init();
