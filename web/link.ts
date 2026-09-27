// Yon Link phone page: pair once (QR → URL fragment), then send files to the
// computer and receive files from it over sealed requests.
// Protocol: src-tauri/src/link/mod.rs (upload) and link/outbox.rs (download).
// Every text shown here goes through textContent, never innerHTML.
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { COMPUTER_TO_PHONE, PHONE_TO_COMPUTER, ReplayWindow, deriveKey, open, seal } from "./crypto";

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

const STORE = "yon-link-pairing";
const MAX_RETRIES = 20;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readPairing(): { p: Uint8Array; k: Uint8Array } | null {
  const parse = (s: string | null) => /^#?([0-9a-f]{32})\.([0-9a-f]{64})$/i.exec(s ?? "");
  let m = parse(location.hash);
  // WHY: the fragment is the source of truth (it survives "Add to Home
  // Screen"); localStorage is only a fallback if a browser drops it.
  try {
    if (m) localStorage.setItem(STORE, m[0].replace(/^#/, ""));
    else m = parse(localStorage.getItem(STORE));
  } catch {
    // storage blocked (private mode): the fragment alone is enough
  }
  return m ? { p: hexToBytes(m[1].toLowerCase()), k: hexToBytes(m[2].toLowerCase()) } : null;
}

class Session {
  private ctr = 0n;
  private replies = new ReplayWindow();
  private inflight: AbortController | null = null;

  private constructor(
    private readonly sid: Uint8Array,
    private readonly key: Uint8Array,
    readonly computer: string,
  ) {}

  static async start(p: Uint8Array, k: Uint8Array): Promise<Session> {
    const nc = crypto.getRandomValues(new Uint8Array(16));
    const res = await fetch(`/hello?p=${bytesToHex(p)}&nc=${bytesToHex(nc)}`, { cache: "no-store" });
    if (res.status === 404) throw new Gone();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = await res.json();
    const hex32 = /^[0-9a-f]{32}$/;
    if (!hex32.test(v?.sid) || !hex32.test(v?.ns) || typeof v?.name !== "string") {
      throw new Error("bad hello");
    }
    const ns = hexToBytes(v.ns);
    return new Session(hexToBytes(v.sid), deriveKey(k, ns, nc), v.name);
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
    const res = await fetch(target, {
      method: "POST",
      headers: { "X-Yon-Sid": bytesToHex(this.sid), "X-Yon-Ctr": ctr.toString() },
      body: seal(this.key, PHONE_TO_COMPUTER, ctr, route, this.sid, body) as Uint8Array<ArrayBuffer>,
      cache: "no-store",
      signal,
    });
    if (res.status === 404) throw new Gone();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = BigInt(res.headers.get("X-Yon-Ctr") ?? "0");
    // Replies to parallel requests may arrive out of order; each only once.
    if (!this.replies.isFresh(out)) throw new Error("stale reply");
    const sealed = new Uint8Array(await res.arrayBuffer());
    const plain = open(this.key, COMPUTER_TO_PHONE, out, route, this.sid, sealed);
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
  incoming: el("incoming"),
  offerText: el("offer-text"),
  offerFiles: el("offer-files"),
  receive: el<HTMLButtonElement>("receive"),
  decline: el<HTMLButtonElement>("decline"),
  saved: el("saved"),
  saveHint: el("save-hint"),
  input: el<HTMLInputElement>("files"),
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
  for (const s of [ui.pick, ui.incoming, ui.busy, ui.end]) s.hidden = s !== section;
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

// ---- Sending ----

let pairing: { p: Uint8Array; k: Uint8Array } | null = null;
let computer = "your computer";
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

async function send(files: File[]) {
  if (!pairing || files.length === 0) return;
  ui.status.textContent = "Connecting…";
  ui.detail.textContent = "";
  ui.fill.style.width = "0%";
  ui.cancel.hidden = false;
  show(ui.busy);

  let job: { session: Session; cancelled: boolean } | null = null;
  try {
    const session = await Session.start(pairing.p, pairing.k);
    job = current = { session, cancelled: false };
    computer = session.computer;

    ui.status.textContent = `Waiting for ${computer} to accept…`;
    const meta = files.map((f) => ({ name: f.name, size: f.size }));
    const answer = await session.call("/request", utf8ToBytes(JSON.stringify({ files: meta })));
    if (answer.result !== "accepted") return refused(answer);

    const chunk = answer.chunk ?? 1 << 20;
    const total = files.reduce((n, f) => n + f.size, 0);
    const before = (f: number) => files.slice(0, f).reduce((n, x) => n + x.size, 0);
    ui.status.textContent = files.length === 1 ? `Sending ${files[0].name}` : `Sending ${files.length} files`;

    let f = 0;
    let i = 0;
    for (;;) {
      while (f < files.length) {
        const file = files[f];
        progress(before(f) + Math.min(i * chunk, file.size), total);
        const start = i * chunk;
        const data = new Uint8Array(await file.slice(start, start + chunk).arrayBuffer());
        const r = await retrying(job, () => session.call(`/chunk?f=${f}&i=${i}`, data));
        if (r.result !== "ok" && r.result !== "resume") return stopped(r);
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
        return stopped(done);
      }
      f = done.file!;
      i = done.next!;
    }
    const n = files.length === 1 ? "1 file" : `${files.length} files`;
    finish(`Sent ${n} to ${computer}.`, "ok", "Send more", pickAgain);
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
      finish(`Can't reach ${computer}. Check that it's on the same Wi-Fi and Yon is open.`, "bad", "Try again", pickAgain);
    }
  } finally {
    if (current === job) current = null;
  }
}

function refused(r: Reply) {
  const text: Record<string, string> = {
    declined: `${computer} declined.`,
    busy: `${computer} is busy with another transfer. Try again in a moment.`,
    insufficient_space: `Not enough free space on ${computer}.`,
  };
  finish(text[r.result] ?? `Can't send: ${r.reason ?? r.result}.`, "bad", "Send something else", pickAgain);
}

function stopped(r: Reply) {
  const text =
    r.result === "cancelled"
      ? `Cancelled on ${computer}.`
      : `Sending failed${r.reason ? `: ${r.reason}` : ""}. Files already sent were kept.`;
  finish(text, "bad", "Send again", pickAgain);
}

function pickAgain() {
  show(ui.pick);
}

// ---- Receiving (computer → phone) ----

const standalone =
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** Parallel chunk requests: fills the Wi-Fi without much memory (spike: 1 → ~3× faster). */
const PULLS = 3;
/** Session for /inbox and downloads; replaced when it expires. */
let listener: Session | null = null;
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

async function listenerSession(): Promise<Session> {
  if (!listener) listener = await Session.start(pairing!.p, pairing!.k);
  return listener;
}

/** Run with the listener session; if it expired (iOS suspended the page for
 * a while), start a new one and try again. Offers belong to the phone, so a
 * new session carries on where the old one stopped. */
async function withListener<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  try {
    return await fn(await listenerSession());
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
    listener = null;
    return fn(await listenerSession());
  }
}

/** Ask the computer for offers while the page is visible and idle. */
async function listen() {
  let backoff = 1000;
  for (;;) {
    await whenVisible();
    if (current || receiving || !ui.incoming.hidden) {
      await sleep(1000);
      continue;
    }
    try {
      const r = (await withListener((s) => s.call("/inbox"))) as unknown as { offer: unknown };
      backoff = 1000;
      if (r.offer && isOffer(r.offer) && !current && !receiving) showOffer(r.offer);
    } catch (e) {
      listener = null;
      if (e instanceof Gone) return; // not paired any more: hello says 404
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

function showOffer(o: Offer) {
  const n = o.files.length === 1 ? "a file" : `${o.files.length} files`;
  ui.offerText.textContent = `${o.from} wants to send you ${n} (${formatBytes(o.total)}).`;
  ui.offerFiles.replaceChildren(...o.files.slice(0, 5).map((f) => fileRow(f.name, f.size)));
  if (o.files.length > 5) ui.offerFiles.append(fileRow(`and ${o.files.length - 5} more`, o.total));
  ui.receive.onclick = () => void receive(o);
  ui.decline.onclick = () => {
    void withListener((s) => s.call(`/offer/decline?o=${o.id}`)).catch(() => {});
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

async function pull(o: Offer, f: number, i: number): Promise<Uint8Array> {
  const plain = await withListener((s) => s.request(`/pull?o=${o.id}&f=${f}&i=${i}`));
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

async function receive(o: Offer) {
  const job = { cancelled: false };
  receiving = job;
  ui.status.textContent = `Receiving from ${o.from}`;
  ui.detail.textContent = "";
  ui.fill.style.width = "0%";
  ui.cancel.hidden = false;
  ui.cancel.onclick = () => {
    job.cancelled = true;
    void withListener((s) => s.call(`/offer/cancel?o=${o.id}`)).catch(() => {});
    finish("Cancelled.", "bad", "Done", pickAgain);
  };
  show(ui.busy);
  const received: { name: string; blob: Blob }[] = [];
  try {
    const ok = await withListener((s) => s.call(`/offer/accept?o=${o.id}`));
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
          const data = await retrying(job, () => pull(o, f, i));
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
    const end = await withListener((s) => s.call(`/offer/done?o=${o.id}`));
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
  void send(files);
});

ui.cancel.addEventListener("click", () => {
  const job = current;
  if (!job || receiving) return;
  job.cancelled = true;
  job.session.abort();
  void job.session.call("/cancel").catch(() => {}); // best effort; the computer also times out
  finish("Cancelled.", "bad", "Send something else", pickAgain);
});

async function init() {
  pairing = readPairing();
  el("add-home").hidden = standalone;
  if (!pairing) {
    ui.subtitle.textContent = "Open this page by scanning the QR code in Yon on your computer (Settings → Phones).";
    return;
  }
  try {
    const s = await listenerSession();
    computer = s.computer;
    el("title").textContent = `Send to ${computer}`;
    ui.subtitle.textContent = "Paired with Yon";
    show(ui.pick);
    void listen();
  } catch (e) {
    ui.subtitle.textContent =
      e instanceof Gone
        ? "This phone isn't paired with the computer anymore. Pair it again from Yon's settings."
        : "Can't reach the computer. Check that it's on the same Wi-Fi and Yon is open.";
    finish("", "bad", "Try again", () => location.reload());
  }
}

// A new QR scanned while this page is open only changes the fragment.
window.addEventListener("hashchange", () => location.reload());

void init();
