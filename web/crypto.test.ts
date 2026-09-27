import { expect, test } from "bun:test";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import vectors from "./crypto-vectors.json";
import { deriveKey, open, seal } from "./crypto";

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
