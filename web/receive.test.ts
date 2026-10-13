import { expect, test } from "bun:test";
import { isIOS, kindOf, sender } from "./receive";

test("kindOf: MIME type decides first", () => {
  expect(kindOf("notes.bin", "image/png")).toBe("image");
  expect(kindOf("clip.dat", "video/quicktime")).toBe("video");
  expect(kindOf("doc.pdf", "application/pdf")).toBe("other");
});

test("kindOf: extension when the MIME type says nothing useful", () => {
  expect(kindOf("a.jpg", "application/octet-stream")).toBe("image");
  expect(kindOf("a.webp", "")).toBe("image");
  expect(kindOf("a.mp4", "")).toBe("video");
  expect(kindOf("a.3gp", "")).toBe("video");
  expect(kindOf("a.pdf", "")).toBe("other");
});

test("kindOf: extension is case-insensitive", () => {
  expect(kindOf("IMG_0001.HEIC", "")).toBe("image");
  expect(kindOf("MOVIE.MOV", "")).toBe("video");
});

test("kindOf: heic by MIME and by extension", () => {
  expect(kindOf("x", "image/heic")).toBe("image");
  expect(kindOf("IMG.heif", "")).toBe("image");
});

test("kindOf: SVG is other (Photos rejects it), by MIME and by extension", () => {
  expect(kindOf("logo.svg", "image/svg+xml")).toBe("other");
  expect(kindOf("logo.svg", "")).toBe("other");
  expect(kindOf("logo.svg", "image/png")).toBe("other");
  expect(kindOf("x", "image/svg+xml")).toBe("other");
});

test("kindOf: unknown or missing extension is other", () => {
  expect(kindOf("archive.zip", "application/zip")).toBe("other");
  expect(kindOf("README", "")).toBe("other");
  expect(kindOf("photo", "")).toBe("other");
});

test("sender: the computer itself is never named as relay", () => {
  expect(sender("Mac", "Mac")).toBe("Mac");
});

test("sender: a phone relayed through a computer names it", () => {
  expect(sender("Leo's iPhone", "Mac")).toBe("Leo's iPhone via Mac");
});

test("isIOS: iPhone, iPad and iPod user agents", () => {
  expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone", 5)).toBe(true);
  expect(isIOS("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "iPad", 5)).toBe(true);
  expect(isIOS("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0)", "iPod", 5)).toBe(true);
});

test("isIOS: iPadOS reporting MacIntel needs touch points", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  expect(isIOS(mac, "MacIntel", 5)).toBe(true);
  expect(isIOS(mac, "MacIntel", 0)).toBe(false);
});

test("isIOS: Android is not iOS", () => {
  expect(isIOS("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36", "Linux armv8l", 5)).toBe(false);
});
