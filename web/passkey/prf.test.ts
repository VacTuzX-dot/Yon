import { expect, test } from "bun:test";
import { hex, prfFirst } from "./prf";

test("prfFirst reads an ArrayBuffer or a view, and nothing else", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  expect(prfFirst({ prf: { results: { first: bytes.buffer } } })).toEqual(bytes);
  expect(prfFirst({ prf: { results: { first: new Uint8Array([9, 1, 2, 3]).subarray(1) } } })).toEqual(bytes);
  expect(prfFirst({ prf: { enabled: true } })).toBeNull();
  expect(prfFirst({ prf: { results: { first: "nope" } } })).toBeNull();
  expect(prfFirst(null)).toBeNull();
  expect(prfFirst({})).toBeNull();
});

test("hex keeps leading zeros and cuts to n bytes", () => {
  expect(hex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  expect(hex(new Uint8Array([0, 15, 255]), 2)).toBe("000f");
});
