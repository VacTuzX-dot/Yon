import { expect, test } from "bun:test";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import vectors from "./crypto-vectors.json";
import { ReplayWindow, deriveKey, open, seal } from "./crypto";

// Same vectors as src-tauri/src/link/crypto.rs: ring and noble must agree.
for (const v of vectors) {
  test(`vector ${v.name} matches the Rust side`, () => {
    const key = deriveKey(hexToBytes(v.k), hexToBytes(v.ns), hexToBytes(v.nc));
    const sid = hexToBytes(v.sid);
    const counter = BigInt(v.counter);
    const sealed = seal(key, v.dir, counter, v.route, sid, utf8ToBytes(v.plain));
    expect(bytesToHex(sealed)).toBe(v.sealed);
    expect(new TextDecoder().decode(open(key, v.dir, counter, v.route, sid, sealed))).toBe(v.plain);
  });
}

test("tampering is rejected", () => {
  const key = deriveKey(new Uint8Array(32).fill(7), new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
  const sid = new Uint8Array(16).fill(3);
  const sealed = seal(key, 1, 5n, "POST /chunk", sid, utf8ToBytes("hello"));
  expect(() => open(key, 2, 5n, "POST /chunk", sid, sealed)).toThrow();
  expect(() => open(key, 1, 6n, "POST /chunk", sid, sealed)).toThrow();
  const bad = sealed.slice();
  bad[0] ^= 1;
  expect(() => open(key, 1, 5n, "POST /chunk", sid, bad)).toThrow();
});

test("replay window matches the Rust rules", () => {
  const w = new ReplayWindow();
  expect(w.isFresh(0n)).toBe(false);
  for (const c of [1n, 3n, 2n, 10n, 5n]) {
    expect(w.isFresh(c)).toBe(true);
    w.mark(c);
    expect(w.isFresh(c)).toBe(false);
  }
  expect(w.isFresh(4n) && w.isFresh(9n)).toBe(true);
  w.mark(80n);
  expect(w.isFresh(10n) || w.isFresh(16n)).toBe(false);
  expect(w.isFresh(17n)).toBe(true);
  w.mark(17n);
  expect(w.isFresh(17n)).toBe(false);
  w.mark(1000n);
  expect(w.isFresh(80n)).toBe(false);
  expect(w.isFresh(999n)).toBe(true);
});
