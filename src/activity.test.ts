import { expect, test } from "bun:test";
import { addEntry, ago, MAX_ACTIVITY, type ActivityEntry } from "./activity";

const e = (id: number, dir: "in" | "out" = "in"): ActivityEntry => ({
  id,
  dir,
  who: "MEO-PC",
  text: "Received 1 file",
  at: id,
});

test("newest first, one entry per transfer and direction, capped", () => {
  let list: ActivityEntry[] = [];
  list = addEntry(list, e(1));
  list = addEntry(list, e(2));
  list = addEntry(list, e(1, "out")); // same id, other direction: kept apart
  list = addEntry(list, { ...e(2), text: "again" }); // same transfer: replaced
  expect(list.map((x) => `${x.dir}${x.id}:${x.text}`)).toEqual([
    "in2:again",
    "out1:Received 1 file",
    "in1:Received 1 file",
  ]);
  for (let i = 10; i < 200; i++) list = addEntry(list, e(i));
  expect(list.length).toBe(MAX_ACTIVITY);
  expect(list[0].id).toBe(199);
});

test("relative times", () => {
  const now = 10_000_000;
  expect(ago(now - 5_000, now)).toBe("just now");
  expect(ago(now + 5_000, now)).toBe("just now"); // clock skew never goes negative
  expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
});
