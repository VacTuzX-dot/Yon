import { expect, test } from "bun:test";
import { b64url, generateVapidKey, rawPublicKey, subscribeBody, unb64url } from "./push";

test("b64url: no padding, URL-safe alphabet", () => {
  // 0xfb 0xff encodes to "+/8=" in standard base64, "-_8" in base64url.
  expect(b64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  expect(b64url(new Uint8Array([0xfb, 0xff]).buffer)).toBe("-_8");
  expect(b64url(new Uint8Array([0x61]))).toBe("YQ");
  expect(b64url(new Uint8Array())).toBe("");
});

test("b64url round-trips every length from 0 to 70 bytes", () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    const s = b64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect(Array.from(unb64url(s))).toEqual(Array.from(bytes));
  }
});

test("unb64url rejects the standard alphabet, padding and impossible lengths", () => {
  expect(() => unb64url("+/8=")).toThrow();
  expect(() => unb64url("YQ==")).toThrow();
  expect(() => unb64url("Y")).toThrow();
  expect(() => unb64url("a b")).toThrow();
});

test("rawPublicKey: 65 bytes, 0x04 then x then y", () => {
  const x = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const y = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
  const pub = rawPublicKey(x, y);
  expect(pub.length).toBe(65);
  expect(pub[0]).toBe(0x04);
  expect(Array.from(pub.subarray(1, 33))).toEqual(Array.from(x));
  expect(Array.from(pub.subarray(33))).toEqual(Array.from(y));
});

test("rawPublicKey rejects coordinates of the wrong size", () => {
  expect(() => rawPublicKey(new Uint8Array(31), new Uint8Array(32))).toThrow();
  expect(() => rawPublicKey(new Uint8Array(32), new Uint8Array(33))).toThrow();
});

test("generateVapidKey: a P-256 key whose d signs and whose x,y verify", async () => {
  const key = await generateVapidKey();
  expect(unb64url(key.d).length).toBe(32);
  expect(unb64url(key.x).length).toBe(32);
  expect(unb64url(key.y).length).toBe(32);

  // WHY: the computer signs VAPID JWTs with d; the browser checks them with x,y. Prove the pair matches.
  const priv = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: key.d, x: key.x, y: key.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const pub = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: key.x, y: key.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const msg = new TextEncoder().encode("header.payload");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, msg);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, msg)).toBe(true);
});

test("subscribeBody: the exact contract fields, sizes and encodings", async () => {
  const key = await generateVapidKey();
  const p256dh = new Uint8Array(65);
  p256dh[0] = 0x04;
  p256dh.fill(7, 1);
  const auth = new Uint8Array(16).fill(9);
  const body = subscribeBody("https://web.push.apple.com/abc", p256dh.buffer, auth.buffer, key);

  expect(Object.keys(body).sort()).toEqual(["auth", "endpoint", "p256dh", "vapid_d", "vapid_pub"]);
  expect(body.endpoint).toBe("https://web.push.apple.com/abc");
  expect(unb64url(body.p256dh)).toEqual(p256dh);
  expect(unb64url(body.auth)).toEqual(auth);
  expect(body.vapid_d).toBe(key.d);
  const pub = unb64url(body.vapid_pub);
  expect(pub.length).toBe(65);
  expect(pub[0]).toBe(0x04);
  expect(body.vapid_pub).toBe(b64url(rawPublicKey(unb64url(key.x), unb64url(key.y))));
});

test("subscribeBody refuses keys of the wrong size or missing keys", async () => {
  const key = await generateVapidKey();
  const ok65 = new Uint8Array(65).fill(4).buffer;
  const ok16 = new Uint8Array(16).buffer;
  const ep = "https://fcm.googleapis.com/x";
  expect(() => subscribeBody(ep, null, ok16, key)).toThrow();
  expect(() => subscribeBody(ep, ok65, null, key)).toThrow();
  expect(() => subscribeBody(ep, new Uint8Array(64).buffer, ok16, key)).toThrow();
  expect(() => subscribeBody(ep, ok65, new Uint8Array(15).buffer, key)).toThrow();
});
