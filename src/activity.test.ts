import { expect, test } from "bun:test";
import { addEntry, ago, MAX_ACTIVITY, restore, serialize, type ActivityEntry } from "./activity";

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

test("older entries show their day", () => {
  const now = new Date(2026, 8, 30, 12, 0).getTime();
  const threeDaysAgo = new Date(2026, 8, 27, 9, 30).getTime();
  const text = ago(threeDaysAgo, now);
  expect(text).toContain("27");
  const earlierToday = new Date(2026, 8, 30, 0, 5).getTime();
  expect(ago(earlierToday, now)).not.toContain("30"); // time of day only
});

test("saved entries come back without ids that could clash or paths to reveal", () => {
  const list: ActivityEntry[] = [
    { id: 7, dir: "in", who: "MEO-PC", text: "Received 2 files", tone: "ok", at: 1000, canReveal: true },
    { id: 7, dir: "out", who: "iPhone", text: "Declined", at: 2000 },
  ];
  const back = restore(serialize(list));
  expect(back.map((x) => [x.dir, x.who, x.text, x.tone, x.at])).toEqual([
    ["in", "MEO-PC", "Received 2 files", "ok", 1000],
    ["out", "iPhone", "Declined", undefined, 2000],
  ]);
  expect(back.every((x) => x.id < 0 && !x.canReveal)).toBe(true);
  expect(new Set(back.map((x) => x.id)).size).toBe(2);
  // a new transfer with the same number doesn't replace a restored one
  expect(addEntry(back, { id: 7, dir: "in", who: "x", text: "y", at: 3 }).length).toBe(3);
});

test("nothing that names a file is saved", () => {
  const saved = serialize([
    { id: 1, dir: "out", who: "Mac", text: "Couldn't send: No such file: /Users/me/tax-2026.pdf", tone: "bad", at: 1 },
    { id: 2, dir: "in", who: "Mac", text: "Couldn't receive: disk full writing salary.xlsx", tone: "bad", at: 2 },
  ]);
  expect(saved).not.toContain("tax-2026");
  expect(saved).not.toContain("salary");
  expect(restore(saved).map((x) => x.text)).toEqual(["Couldn't send", "Couldn't receive"]);
});

test("bad or hostile saved data is ignored", () => {
  expect(restore(null)).toEqual([]);
  expect(restore("not json")).toEqual([]);
  expect(restore('{"a":1}')).toEqual([]);
  expect(restore('[1,null,"x",{"dir":"sideways","who":"a","text":"b","at":1},{"dir":"in","who":5,"text":"b","at":1},{"dir":"in","who":"a","text":"b","at":"now"}]')).toEqual([]);
  const huge = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ dir: "in", who: "a".repeat(5000), text: "t".repeat(5000), at: i })));
  const out = restore(huge);
  expect(out.length).toBe(MAX_ACTIVITY);
  expect(out[0].who.length).toBe(100);
  expect(out[0].text.length).toBe(300);
});
