// Yon Link session crypto for the phone page. Must match
// src-tauri/src/link/crypto.rs byte for byte (see crypto-vectors.json).
// WebCrypto's `subtle` API isn't available on http:// pages, so this uses the
// audited @noble libraries; randomness comes from crypto.getRandomValues.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const INFO = utf8ToBytes("yon-link v1");

export const PHONE_TO_COMPUTER = 1;
export const COMPUTER_TO_PHONE = 2;

export function deriveKey(k: Uint8Array, ns: Uint8Array, nc: Uint8Array): Uint8Array {
  return hkdf(sha256, k, concatBytes(ns, nc), INFO, 32);
}

function counterBytes(counter: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, counter);
  return b;
}

function nonce(dir: number, counter: bigint): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = dir;
  n.set(counterBytes(counter), 4);
  return n;
}

function aad(route: string, sid: Uint8Array, counter: bigint): Uint8Array {
  return concatBytes(INFO, utf8ToBytes(route), sid, counterBytes(counter));
}

export function seal(
  key: Uint8Array,
  dir: number,
  counter: bigint,
  route: string,
  sid: Uint8Array,
  plain: Uint8Array,
): Uint8Array {
  return chacha20poly1305(key, nonce(dir, counter), aad(route, sid, counter)).encrypt(plain);
}

/** Throws on any tampering or mismatch. */
export function open(
  key: Uint8Array,
  dir: number,
  counter: bigint,
  route: string,
  sid: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  return chacha20poly1305(key, nonce(dir, counter), aad(route, sid, counter)).decrypt(sealed);
}
