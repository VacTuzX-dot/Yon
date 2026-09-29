import { expect, test } from "bun:test";
import type { Device } from "./api";
import { group, kindOf, labels, matches } from "./devices";

const dev = (id: string, name: string, os: string, extra: Partial<Device> = {}): Device => ({
  id,
  name,
  os,
  app: "",
  compatible: true,
  folders: true,
  short_fingerprint: "",
  ...extra,
});

test("kind follows the OS", () => {
  expect(kindOf(dev("a", "A", "macos"))).toBe("laptop");
  expect(kindOf(dev("b", "B", "windows"))).toBe("desktop");
  expect(kindOf(dev("c", "C", "phone"))).toBe("phone");
  expect(kindOf(dev("d", "D", "android"))).toBe("phone");
});

test("same names get a code, others don't", () => {
  const l = labels([
    dev("m1", "MacBook", "macos", { short_fingerprint: "4f2a-91c0" }),
    dev("m2", "macbook", "macos", { short_fingerprint: "77be-0000" }),
    dev("phone:ab12cd", "Leo's iPhone", "phone"),
  ]);
  expect(l.m1).toBe("MacBook · 4F2A");
  expect(l.m2).toBe("macbook · 77BE");
  expect(l["phone:ab12cd"]).toBe("Leo's iPhone");
});

test("ready first, recent first, then by name; closed phones wait", () => {
  const { ready, waiting } = group(
    [
      dev("z", "Zed PC", "windows"),
      dev("a", "Alpha Mac", "macos"),
      dev("r", "Recent PC", "windows"),
      dev("phone:1", "Closed phone", "phone", { online: false }),
      dev("phone:2", "Open phone", "phone", { online: true }),
      dev("old", "Old Yon", "macos", { compatible: false }),
    ],
    { r: 2, "phone:2": 1 },
  );
  expect(ready.map((d) => d.id)).toEqual(["r", "phone:2", "a", "z", "old"]);
  expect(waiting.map((d) => d.id)).toEqual(["phone:1"]);
});

test("search matches name or OS, ignoring case", () => {
  const d = dev("a", "Desk", "windows");
  expect(matches(d, "Desk", "")).toBe(true);
  expect(matches(d, "Desk", "des")).toBe(true);
  expect(matches(d, "Desk", "WIN")).toBe(true);
  expect(matches(d, "Desk", "mac")).toBe(false);
});

test("two phones with the same name are told apart by their code", () => {
  const l = labels([
    dev("phone:a1b2c3d4e5f60718a1b2c3d4e5f60718", "Phone", "phone"),
    dev("phone:0f0e0d0c0b0a09080706050403020100", "Phone", "phone"),
  ]);
  expect(Object.values(l)).toEqual(["Phone · A1B2", "Phone · 0F0E"]);
});

test("search finds a same-named device by the code in its label", () => {
  const d = dev("x", "Desk", "windows", { short_fingerprint: "4F2A-0000-0000-0000" });
  expect(matches(d, "Desk · 4F2A", "4f2a")).toBe(true);
  expect(matches(d, "Desk", "4f2a")).toBe(false);
});
