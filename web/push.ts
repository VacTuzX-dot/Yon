// Web Push for the phone page (spec docs/superpowers/specs/2026-10-13-phone-push-design.md).
// The phone owns one VAPID key and one push subscription, and gives both to each
// paired computer over the sealed session, so any of them can push to this phone.
// No work at import time (no DOM, no navigator): the pure helpers are unit-tested (push.test.ts).
import { isIOS } from "./receive";

/** Sends a sealed request to every online computer; link.ts provides it. Never rejects. */
export type Send = (path: string, body?: unknown) => Promise<void>;

/** The VAPID key pair as JWK fields (base64url, no padding). d never leaves this phone except to its own computers. */
export type VapidKey = { d: string; x: string; y: string };

/** Body of POST /push/subscribe: the contract with the computer (src-tauri/src/link/mod.rs). */
export type SubscribeBody = {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapid_d: string;
  vapid_pub: string;
};

const KEY = "yon-push";
const B64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding (RFC 4648 §5). */
export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of b64url. Throws on "+", "/", "=" or a length that cannot be base64. */
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  // WHY: reject the standard alphabet too; accepting it would hide a wrong encoder on the other side.
  if (!B64URL.test(s) || s.length % 4 === 1) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The uncompressed point 0x04 ‖ x ‖ y (65 bytes): the applicationServerKey and vapid_pub. */
export function rawPublicKey(x: Uint8Array, y: Uint8Array): Uint8Array<ArrayBuffer> {
  if (x.length !== 32 || y.length !== 32) throw new Error("P-256 coordinates are 32 bytes");
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

/** A fresh P-256 key pair from WebCrypto, exported as JWK (d, x, y are already base64url). */
/** Left-pads a base64url P-256 scalar or coordinate to its full 32 bytes.
 * WHY: RFC 7518 says JWK d/x/y are full length, but some WebCrypto exports
 * (seen in Bun on Windows) drop leading zero bytes — about 1 key in 256. The
 * computer requires exactly 32 bytes, so normalise here. */
export function pad32(v: string): string {
  const bytes = unb64url(v);
  if (bytes.length > 32) throw new Error("P-256 value longer than 32 bytes");
  if (bytes.length === 32) return v;
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return b64url(out);
}

export async function generateVapidKey(): Promise<VapidKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("WebCrypto returned no P-256 key");
  return { d: pad32(jwk.d), x: pad32(jwk.x), y: pad32(jwk.y) };
}

/** The POST /push/subscribe body for one subscription and the key it was made with. */
export function subscribeBody(
  endpoint: string,
  p256dh: ArrayBuffer | null,
  auth: ArrayBuffer | null,
  key: VapidKey,
): SubscribeBody {
  // WHY: fail here on a wrong size instead of letting the computer reject it later.
  if (!p256dh || p256dh.byteLength !== 65 || !auth || auth.byteLength !== 16) {
    throw new Error("push subscription keys have the wrong size");
  }
  return {
    endpoint,
    p256dh: b64url(p256dh),
    auth: b64url(auth),
    vapid_d: key.d,
    vapid_pub: b64url(rawPublicKey(unb64url(key.x), unb64url(key.y))),
  };
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null; // WHY: some browsers throw on access in private mode
  }
}

const isKeyPart = (s: unknown): s is string => typeof s === "string" && s.length === 43 && B64URL.test(s);

function readKey(): VapidKey | null {
  try {
    const v = JSON.parse(storage()?.getItem(KEY) ?? "null") as Partial<VapidKey> | null;
    return v && isKeyPart(v.d) && isKeyPart(v.x) && isKeyPart(v.y) ? { d: v.d, x: v.x, y: v.y } : null;
  } catch {
    return null; // WHY: a corrupt entry means no key, so the switch shows off
  }
}

/** Stores the key, or removes it when null. False when the browser blocks storage. */
function writeKey(k: VapidKey | null): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (k) s.setItem(KEY, JSON.stringify(k));
    else s.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  return new Uint8Array(a).every((v, i) => v === b[i]);
}

function isStandalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** The browser has the APIs push needs (ignores the iOS Home Screen rule). */
export function pushSupported(): boolean {
  return isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Push can be turned on here. On iOS only from the Home Screen app: Safari tabs get no push. */
export function canPush(): boolean {
  if (!pushSupported()) return false;
  return !isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) || isStandalone();
}

/** Push is on when this phone holds a VAPID key for it. */
export function isPushOn(): boolean {
  return readKey() !== null;
}

/** The page's worker registration once it is active; null when push was never set up here. */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  // WHY: `ready` never resolves without a registration, so check for one first.
  if (!(await navigator.serviceWorker.getRegistration())) return null;
  return navigator.serviceWorker.ready;
}

/** The one subscription for this key. One bound to another key is dropped first: a worker has one subscription, bound to one key. */
async function subscribeWith(reg: ServiceWorkerRegistration, key: VapidKey): Promise<PushSubscription> {
  const pub = rawPublicKey(unb64url(key.x), unb64url(key.y));
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, pub)) {
    await sub.unsubscribe();
    sub = null;
  }
  // WHY: WebKit needs a BufferSource for applicationServerKey, not a plain array.
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pub });
}

/** Subscribe with `key`, then give the subscription to the computers. */
async function publish(reg: ServiceWorkerRegistration, key: VapidKey, send: Send): Promise<void> {
  const sub = await subscribeWith(reg, key);
  await send("/push/subscribe", subscribeBody(sub.endpoint, sub.getKey("p256dh"), sub.getKey("auth"), key));
}

/** Turn push on. Call from a tap: the permission prompt has to stay inside the gesture. */
export async function enablePush(send: Send): Promise<"ok" | "denied" | "failed"> {
  if (!canPush()) return "failed";
  // WHY: this call starts before any await, so the browser still sees the tap.
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  try {
    await navigator.serviceWorker.register("sw.js");
    const reg = await navigator.serviceWorker.ready;
    let key = readKey();
    if (!key) {
      key = await generateVapidKey();
      if (!writeKey(key)) return "failed";
    }
    await publish(reg, key, send);
    return "ok";
  } catch (e) {
    console.error(e);
    return "failed";
  }
}

/** Turn push off: drop the subscription, tell the computers (best effort), forget the key. */
export async function disablePush(send: Send): Promise<void> {
  try {
    const reg = await activeRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch (e) {
    console.error(e); // WHY: still tell the computers and drop the key below
  }
  await send("/push/unsubscribe");
  writeKey(null);
}

/** After Forget, with push on: a new key and subscription, so the forgotten computer's copy of the old pair goes stale. */
export async function rotatePush(send: Send): Promise<"ok" | "failed"> {
  try {
    const reg = await activeRegistration();
    if (!reg) return "failed";
    // WHY: the new key is stored before the old subscription is dropped. If the page is closed in between, the next open repairs the subscription (resendSubscription) instead of losing the key.
    const key = await generateVapidKey();
    if (!writeKey(key)) return "failed";
    await publish(reg, key, send);
    return "ok";
  } catch (e) {
    console.error(e);
    return "failed";
  }
}

/** On each open while push is on: make the subscription match the stored key and give it to the online computers. Idempotent. */
export async function resendSubscription(send: Send): Promise<void> {
  const key = readKey();
  if (!key || !canPush()) return;
  try {
    const reg = await activeRegistration();
    if (reg) await publish(reg, key, send);
  } catch (e) {
    console.error(e);
  }
}
