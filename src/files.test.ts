import { expect, test } from "bun:test";
import { fileRows, plural } from "./files";

test("folders collapse to one row each, loose files stay, order is kept", () => {
  const rows = fileRows([
    { name: "a.jpg", size: 1, dir: "Photos" },
    { name: "notes.txt", size: 5 },
    { name: "b.jpg", size: 2, dir: "Photos/2024" },
    { name: "c.jpg", size: 4, dir: ["Trip", "day 2"], renamed: true },
  ]);
  expect(rows).toEqual([
    { name: "Photos", size: 3, count: 2, folder: true, renamed: false },
    { name: "notes.txt", size: 5, count: 1, folder: false, renamed: false },
    { name: "Trip", size: 4, count: 1, folder: true, renamed: true },
  ]);
});

test("empty folder lists and plurals", () => {
  expect(fileRows([{ name: "x", size: 0, dir: [] }])[0].folder).toBe(false);
  expect(fileRows([{ name: "x", size: 0, dir: null }])[0].folder).toBe(false);
  expect(plural(1, "file")).toBe("1 file");
  expect(plural(1200, "file")).toBe("1,200 files");
});
