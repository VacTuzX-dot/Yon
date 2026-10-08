// The phone page's list of computers ("keyring"): every pairing that reaches the
// page (URL fragment or scanned QR) is kept in localStorage so one Home Screen
// icon can reach every computer the user owns. Pure: storage is injected.
// Grammar: same as readPairing in link.ts (`<pair id>.<key>[.<room>@<host>]`).

export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type Pairing = {
  id: string; // pair id, 32 lowercase hex
  raw: string; // normalized pairing string, no leading '#'
  relay: boolean; // true for the relay form
};

export const MAX_COMPUTERS = 4; // WHY: one relay WebSocket per computer; the relay allows 16 per IP
export const MAX_FORGOTTEN = 32;
export const COMPUTERS_KEY = "yon-link-computers";
export const FORGOTTEN_KEY = "yon-link-forgotten";
export const LEGACY_KEY = "yon-link-pairing";

const PAIRING = /^([0-9a-f]{32})\.([0-9a-f]{64})(?:\.([0-9a-f]{64})@([a-z0-9.-]+(?::\d{1,5})?))?$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** null for anything that isn't exactly the grammar (no extra chars, no whitespace). */
export function parsePairing(s: string | null | undefined): Pairing | null {
  if (typeof s !== "string") return null;
  // WHY: lowercase before matching, so a pairing typed or scanned in upper case
  // is stored in one canonical form and deduplicates by id.
  const raw = s.toLowerCase().replace(/^#/, "");
  const m = PAIRING.exec(raw);
  if (!m) return null;
  return { id: m[1], raw, relay: m[3] !== undefined };
}

// WHY: a missing key, bad JSON or a wrong shape all mean "empty"; the page
// must still open, so corrupt data is ignored rather than thrown.
function readStored(storage: KeyStore): Pairing[] {
  const raw = storage.getItem(COMPUTERS_KEY);
  if (raw === null) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: Pairing[] = [];
  for (const item of list) {
    const p = typeof item === "string" ? parsePairing(item) : null;
    if (p && !out.some((q) => q.id === p.id)) out.push(p);
  }
  return out;
}

function writeStored(storage: KeyStore, list: Pairing[]): void {
  storage.setItem(COMPUTERS_KEY, JSON.stringify(list.map((p) => p.raw)));
}

function readForgotten(storage: KeyStore): string[] {
  const raw = storage.getItem(FORGOTTEN_KEY);
  if (raw === null) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === "string" && HEX32.test(x));
}

function writeForgotten(storage: KeyStore, list: string[]): void {
  // WHY: keep the newest entries; the oldest forgotten ids are the ones least
  // likely to still be baked into an old Home Screen icon.
  storage.setItem(FORGOTTEN_KEY, JSON.stringify(list.slice(-MAX_FORGOTTEN)));
}

function canAdd(list: Pairing[], p: Pairing, forgotten: string[]): boolean {
  return !forgotten.includes(p.id) && !list.some((s) => s.id === p.id) && list.length < MAX_COMPUTERS;
}

/** Computers to use, fragment first. Never throws. */
export function loadComputers(hash: string, storage: KeyStore | null): Pairing[] {
  const fragment = parsePairing(hash);
  // WHY: without storage (private mode) the fragment alone still works; nothing is written.
  if (!storage) return fragment ? [fragment] : [];

  // Only reads may fail the whole lookup: without them we don't know what is stored.
  let list: Pairing[];
  let forgotten: string[];
  let legacyRaw: string | null;
  try {
    list = readStored(storage);
    forgotten = readForgotten(storage);
    legacyRaw = storage.getItem(LEGACY_KEY);
  } catch {
    return fragment ? [fragment] : [];
  }

  let dirty = false;

  // Migration: the single pairing kept by the previous version under LEGACY_KEY.
  const legacy = parsePairing(legacyRaw);
  if (legacy) {
    if (canAdd(list, legacy, forgotten)) {
      list.push(legacy);
      dirty = true;
    }
    try {
      storage.removeItem(LEGACY_KEY);
    } catch {
      // WHY: a failed removal only means the legacy value is migrated again (deduped by id) next load.
    }
  }

  // The fragment is the source of truth for the icon; it is stored so the
  // "open link with Camera" path accumulates too, unless the user forgot it.
  if (fragment && canAdd(list, fragment, forgotten)) {
    list.push(fragment);
    dirty = true;
  }
  if (dirty) {
    try {
      writeStored(storage, list);
    } catch {
      // WHY: a full or blocked store must not hide computers that were read fine; they are used for this page load.
    }
  }

  if (!fragment || forgotten.includes(fragment.id)) return list;
  // WHY: the fragment comes first even when the keyring is full (it is then
  // not stored, but the icon URL keeps it), and its id is not repeated below.
  return [fragment, ...list.filter((p) => p.id !== fragment.id)];
}

/** Add a pairing to storage. Removes its id from the forgotten list. */
export function addComputer(storage: KeyStore | null, p: Pairing): "added" | "exists" | "full" | "blocked" {
  if (!storage) return "blocked";
  let result: "added" | "exists";
  try {
    const list = readStored(storage);
    const i = list.findIndex((s) => s.id === p.id);
    if (i >= 0) {
      // WHY: the same pair id can come back with a new key (the computer
      // re-paired); the newest string wins.
      if (list[i].raw !== p.raw) {
        list[i] = p;
        writeStored(storage, list);
      }
      result = "exists";
    } else {
      if (list.length >= MAX_COMPUTERS) return "full";
      list.push(p);
      writeStored(storage, list);
      result = "added";
    }
  } catch {
    return "blocked";
  }
  try {
    const forgotten = readForgotten(storage);
    if (forgotten.includes(p.id)) writeForgotten(storage, forgotten.filter((x) => x !== p.id));
  } catch {
    // WHY: the forgotten list is a convenience; the pairing is already stored.
  }
  return result;
}

/** Remove id from the stored list and append it to the forgotten list. Never throws. */
export function forgetComputer(storage: KeyStore | null, id: string): void {
  if (!storage) return;
  try {
    writeStored(
      storage,
      readStored(storage).filter((p) => p.id !== id),
    );
    const forgotten = readForgotten(storage).filter((x) => x !== id);
    forgotten.push(id);
    writeForgotten(storage, forgotten);
  } catch {
    // WHY: best effort; if storage is blocked there is nothing stored to forget.
  }
}

/** Validate text read from a QR code for the page at `page`. */
export function parseScanned(
  text: string,
  page: { origin: string; pathname: string },
): { ok: true; pairing: Pairing } | { ok: false; reason: "lan" | "invalid" } {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // WHY: origin ignores userinfo, so `https://x@yon.meo.in.th/...` would pass the
  // origin check while pointing somewhere a user did not expect. Reject it, and
  // any query, since the real pairing QR has neither.
  if (url.username || url.password || url.search) return { ok: false, reason: "invalid" };

  const p = parsePairing(url.hash);
  // WHY: a LAN link's origin is the computer's own http://<ip>:53421, so it can
  // never equal the page origin; it is recognised by its scheme and fragment only.
  if (url.protocol === "http:") {
    return p && !p.relay ? { ok: false, reason: "lan" } : { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "invalid" };
  if (url.origin !== page.origin || url.pathname !== page.pathname) return { ok: false, reason: "invalid" };
  if (!p || !p.relay) return { ok: false, reason: "invalid" };
  return { ok: true, pairing: p };
}
