import { expect, test } from "bun:test";
import {
  COMPUTERS_KEY,
  FORGOTTEN_KEY,
  LEGACY_KEY,
  MAX_FORGOTTEN,
  addComputer,
  forgetComputer,
  loadComputers,
  parsePairing,
  parseScanned,
  type KeyStore,
  type Pairing,
} from "./keyring";

const id = (c: string) => c.repeat(32);
const hex64 = (c: string) => c.repeat(64);
const lan = (c: string) => `${id(c)}.${hex64("b")}`;
const relay = (c: string, key = "b") => `${id(c)}.${hex64(key)}.${hex64("c")}@relay.example.com`;
const page = { origin: "https://yon.meo.in.th", pathname: "/phonelink/" };

/** In-memory KeyStore; `data` exposes the raw strings for assertions. */
function fakeStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const store: KeyStore = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
  return { store, data };
}

const throwing: KeyStore = {
  getItem() {
    throw new Error("storage blocked");
  },
  setItem() {
    throw new Error("storage blocked");
  },
  removeItem() {
    throw new Error("storage blocked");
  },
};

const pairingOf = (raw: string): Pairing => parsePairing(raw)!;
const storedRaws = (data: Map<string, string>) => JSON.parse(data.get(COMPUTERS_KEY) ?? "null");

test("parsePairing accepts LAN and relay forms", () => {
  expect(parsePairing(lan("1"))).toEqual({ id: id("1"), raw: lan("1"), relay: false });
  expect(parsePairing(relay("2"))).toEqual({ id: id("2"), raw: relay("2"), relay: true });
});

test("parsePairing normalizes case and a leading '#'", () => {
  const upper = relay("a").toUpperCase();
  expect(parsePairing(upper)?.raw).toBe(relay("a"));
  expect(parsePairing("#" + relay("a"))?.raw).toBe(relay("a"));
  expect(parsePairing("#" + upper)?.id).toBe(id("a"));
});

test("parsePairing rejects extra chars, whitespace, short hex and non-strings", () => {
  expect(parsePairing(relay("1") + "/")).toBeNull();
  expect(parsePairing(relay("1") + ":")).toBeNull();
  expect(parsePairing(" " + relay("1"))).toBeNull();
  expect(parsePairing(relay("1") + "\n")).toBeNull();
  expect(parsePairing(lan("1").slice(0, -1))).toBeNull();
  expect(parsePairing(`${id("1").slice(1)}.${hex64("b")}`)).toBeNull();
  expect(parsePairing(`${id("1")}.${hex64("b")}.${hex64("c")}`)).toBeNull(); // room without host
  expect(parsePairing("")).toBeNull();
  expect(parsePairing("#")).toBeNull();
  expect(parsePairing(null)).toBeNull();
  expect(parsePairing(undefined)).toBeNull();
});

test("loadComputers with null storage returns only a valid fragment, writes nothing", () => {
  expect(loadComputers("#" + relay("1"), null)).toEqual([pairingOf(relay("1"))]);
  expect(loadComputers("", null)).toEqual([]);
  expect(loadComputers("#junk", null)).toEqual([]);
});

test("loadComputers with throwing storage falls back to the fragment", () => {
  expect(loadComputers("#" + relay("1"), throwing)).toEqual([pairingOf(relay("1"))]);
  expect(loadComputers("", throwing)).toEqual([]);
});

test("loadComputers stores a fragment pairing that is not yet in the keyring", () => {
  const { store, data } = fakeStore();
  const out = loadComputers("#" + relay("1"), store);
  expect(out.map((p) => p.id)).toEqual([id("1")]);
  expect(storedRaws(data)).toEqual([relay("1")]);
});

test("loadComputers dedupes a fragment already stored; fragment wins on key, no duplicate", () => {
  const { store, data } = fakeStore({ [COMPUTERS_KEY]: JSON.stringify([relay("1"), relay("2")]) });
  const newer = relay("1", "d");
  const out = loadComputers("#" + newer, store);
  expect(out.map((p) => p.raw)).toEqual([newer, relay("2")]);
  // WHY-level expectation: the stored list is not rewritten for an already-stored id.
  expect(storedRaws(data)).toEqual([relay("1"), relay("2")]);
});

test("loadComputers skips a forgotten fragment entirely", () => {
  const { store, data } = fakeStore({
    [COMPUTERS_KEY]: JSON.stringify([relay("2")]),
    [FORGOTTEN_KEY]: JSON.stringify([id("1")]),
  });
  const out = loadComputers("#" + relay("1"), store);
  expect(out.map((p) => p.id)).toEqual([id("2")]);
  expect(storedRaws(data)).toEqual([relay("2")]);
});

test("loadComputers returns a full keyring's fragment first but does not store it", () => {
  const four = [relay("1"), relay("2"), relay("3"), relay("4")];
  const { store, data } = fakeStore({ [COMPUTERS_KEY]: JSON.stringify(four) });
  const out = loadComputers("#" + relay("f"), store);
  expect(out[0].id).toBe(id("f"));
  expect(out.slice(1).map((p) => p.id)).toEqual([id("1"), id("2"), id("3"), id("4")]);
  expect(storedRaws(data)).toEqual(four);
});

test("loadComputers keeps stored computers when setItem and removeItem throw", () => {
  const { store: reader, data } = fakeStore({
    [COMPUTERS_KEY]: JSON.stringify([relay("1"), relay("2")]),
    [LEGACY_KEY]: relay("5"),
  });
  const readOnly: KeyStore = {
    getItem: (k) => reader.getItem(k),
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("QuotaExceededError");
    },
  };
  const out = loadComputers("#" + relay("3"), readOnly);
  expect(out.map((p) => p.id)).toEqual([id("3"), id("1"), id("2"), id("5")]);
  expect(storedRaws(data)).toEqual([relay("1"), relay("2")]);
});

test("loadComputers migrates the legacy pairing once and removes the old key", () => {
  const { store, data } = fakeStore({ [LEGACY_KEY]: relay("1") });
  const out = loadComputers("", store);
  expect(out.map((p) => p.id)).toEqual([id("1")]);
  expect(storedRaws(data)).toEqual([relay("1")]);
  expect(data.has(LEGACY_KEY)).toBe(false);
});

test("loadComputers does not migrate a forgotten legacy pairing, but still removes the key", () => {
  const { store, data } = fakeStore({
    [LEGACY_KEY]: relay("1"),
    [FORGOTTEN_KEY]: JSON.stringify([id("1")]),
  });
  expect(loadComputers("", store)).toEqual([]);
  expect(data.has(LEGACY_KEY)).toBe(false);
  expect(data.has(COMPUTERS_KEY)).toBe(false);
});

test("loadComputers ignores corrupt JSON and non-array values", () => {
  const corrupt = fakeStore({ [COMPUTERS_KEY]: "{not json" });
  expect(loadComputers("#" + relay("1"), corrupt.store).map((p) => p.id)).toEqual([id("1")]);

  const object = fakeStore({ [COMPUTERS_KEY]: JSON.stringify({ a: 1 }) });
  expect(loadComputers("", object.store)).toEqual([]);
});

test("loadComputers drops invalid entries and duplicate ids in the stored list", () => {
  const { store } = fakeStore({
    [COMPUTERS_KEY]: JSON.stringify([42, "garbage", relay("1"), relay("1", "d"), relay("2"), null]),
  });
  expect(loadComputers("", store).map((p) => p.raw)).toEqual([relay("1"), relay("2")]);
});

test("addComputer: added, then exists with the same raw string", () => {
  const { store, data } = fakeStore();
  expect(addComputer(store, pairingOf(relay("1")))).toBe("added");
  expect(addComputer(store, pairingOf(relay("1")))).toBe("exists");
  expect(storedRaws(data)).toEqual([relay("1")]);
});

test("addComputer: exists replaces the stored raw when the key changed", () => {
  const { store, data } = fakeStore({ [COMPUTERS_KEY]: JSON.stringify([relay("1")]) });
  const rekeyed = relay("1", "d");
  expect(addComputer(store, pairingOf(rekeyed))).toBe("exists");
  expect(storedRaws(data)).toEqual([rekeyed]);
});

test("addComputer: full at MAX_COMPUTERS, and does not touch storage", () => {
  const four = [relay("1"), relay("2"), relay("3"), relay("4")];
  const { store, data } = fakeStore({ [COMPUTERS_KEY]: JSON.stringify(four) });
  expect(addComputer(store, pairingOf(relay("5")))).toBe("full");
  expect(storedRaws(data)).toEqual(four);
});

test("addComputer: an already stored id is still 'exists' when the list is full", () => {
  const four = [relay("1"), relay("2"), relay("3"), relay("4")];
  const { store } = fakeStore({ [COMPUTERS_KEY]: JSON.stringify(four) });
  expect(addComputer(store, pairingOf(relay("1")))).toBe("exists");
});

test("addComputer: blocked when storage is null or throws", () => {
  expect(addComputer(null, pairingOf(relay("1")))).toBe("blocked");
  expect(addComputer(throwing, pairingOf(relay("1")))).toBe("blocked");
});

test("addComputer clears the id from the forgotten list", () => {
  const { store, data } = fakeStore({
    [FORGOTTEN_KEY]: JSON.stringify([id("9"), id("1")]),
  });
  expect(addComputer(store, pairingOf(relay("1")))).toBe("added");
  expect(JSON.parse(data.get(FORGOTTEN_KEY)!)).toEqual([id("9")]);
  expect(loadComputers("#" + relay("1"), store).map((p) => p.id)).toEqual([id("1")]);
});

test("forgetComputer removes the id and records it as forgotten", () => {
  const { store, data } = fakeStore({ [COMPUTERS_KEY]: JSON.stringify([relay("1"), relay("2")]) });
  forgetComputer(store, id("1"));
  expect(storedRaws(data)).toEqual([relay("2")]);
  expect(JSON.parse(data.get(FORGOTTEN_KEY)!)).toEqual([id("1")]);
});

test("forgetComputer caps forgotten at 32, dropping the oldest", () => {
  const old = Array.from({ length: MAX_FORGOTTEN }, (_, i) => i.toString(16).padStart(32, "0"));
  const { store, data } = fakeStore({ [FORGOTTEN_KEY]: JSON.stringify(old) });
  const fresh = id("f");
  forgetComputer(store, fresh);
  const forgotten: string[] = JSON.parse(data.get(FORGOTTEN_KEY)!);
  expect(forgotten.length).toBe(MAX_FORGOTTEN);
  expect(forgotten[0]).toBe(old[1]);
  expect(forgotten[forgotten.length - 1]).toBe(fresh);
});

test("forgetComputer never throws", () => {
  expect(() => forgetComputer(null, id("1"))).not.toThrow();
  expect(() => forgetComputer(throwing, id("1"))).not.toThrow();
});

test("parseScanned accepts a relay pairing for this page", () => {
  const r = parseScanned(`https://yon.meo.in.th/phonelink/#${relay("1")}`, page);
  expect(r).toEqual({ ok: true, pairing: pairingOf(relay("1")) });
});

test("parseScanned: LAN link over http is reason 'lan'", () => {
  expect(parseScanned(`http://192.168.1.5:53421/#${lan("1")}`, page)).toEqual({ ok: false, reason: "lan" });
});

test("parseScanned rejects another origin and another path", () => {
  expect(parseScanned(`https://evil.example/phonelink/#${relay("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
  expect(parseScanned(`https://yon.meo.in.th/other/#${relay("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("parseScanned rejects http with a relay fragment", () => {
  expect(parseScanned(`http://yon.meo.in.th/phonelink/#${relay("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("parseScanned rejects https with a LAN fragment", () => {
  expect(parseScanned(`https://yon.meo.in.th/phonelink/#${lan("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("parseScanned rejects javascript: and other schemes", () => {
  expect(parseScanned(`javascript:alert(1)//#${relay("1")}`, page)).toEqual({ ok: false, reason: "invalid" });
  expect(parseScanned(`ftp://yon.meo.in.th/phonelink/#${relay("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("parseScanned rejects userinfo and query tricks that keep the same origin", () => {
  expect(parseScanned(`https://me@yon.meo.in.th/phonelink/#${relay("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
  expect(parseScanned(`https://yon.meo.in.th/phonelink/?x=1#${relay("1")}`, page)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("parseScanned rejects garbage", () => {
  expect(parseScanned("hello", page)).toEqual({ ok: false, reason: "invalid" });
  expect(parseScanned("", page)).toEqual({ ok: false, reason: "invalid" });
  expect(parseScanned(`https://yon.meo.in.th/phonelink/`, page)).toEqual({ ok: false, reason: "invalid" });
});
