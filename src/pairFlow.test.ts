import { expect, test } from "bun:test";
import { nextPairStep, shortName } from "./pairFlow";

test("first time always pairs straight away", () => {
  expect(nextPairStep("new", { remote: false, effective_relay: null })).toBe("pair");
  expect(nextPairStep("new", { remote: true, effective_relay: "wss://r" })).toBe("pair");
});

test("adding to an existing icon needs Reach from anywhere", () => {
  expect(nextPairStep("add", { remote: true, effective_relay: "wss://r" })).toBe("pair");
  expect(nextPairStep("add", { remote: false, effective_relay: "wss://r" })).toBe("needs_remote");
  expect(nextPairStep("add", { remote: false, effective_relay: null })).toBe("no_relay");
});

test("remote on without a relay still can't add", () => {
  expect(nextPairStep("add", { remote: true, effective_relay: null })).toBe("no_relay");
});

test("shortName keeps short names and trims long ones with an ellipsis", () => {
  expect(shortName("Leo's MacBook")).toBe("Leo's MacBook");
  expect(shortName("A very long computer name here")).toBe("A very long comput…");
  expect(shortName("  padded  ")).toBe("padded");
  expect(shortName("abcdef", 3)).toBe("abc…");
});
