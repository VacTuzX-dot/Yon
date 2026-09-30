// The film's static world, built from voxels once at start-up: a small
// bedroom (the story) and, far away, the floating islands the camera flies
// through (how Yon works). Everything that moves lives in story.ts.

import { Voxels, type PaletteEntry, type V3 } from "./engine";

export const PAL: PaletteEntry[] = [];
const c = (hex: string, e = 0) => {
  const n = parseInt(hex.slice(1), 16);
  PAL.push({ c: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], e });
  return PAL.length - 1;
};
export const B = {
  oak: c("#b98a55"),
  oak2: c("#a97a47"),
  plaster: c("#efe6d6"),
  plaster2: c("#e4d8c4"),
  skirt: c("#c9b89c"),
  grass: c("#6fae4f"),
  grass2: c("#62a045"),
  dirt: c("#8a6443"),
  stone: c("#8d8a86"),
  stone2: c("#77736f"),
  leaf: c("#4f9448"),
  leaf2: c("#5ea553"),
  wood: c("#7a5534"),
  desk: c("#d9c3a0"),
  metal: c("#4a4d55"),
  rug: c("#c73a2c"),
  rug2: c("#e8a317"),
  book1: c("#3f6fb5"),
  book2: c("#c73a2c"),
  book3: c("#e8a317"),
  book4: c("#3fae6b"),
  window: c("#bfe3f0", 1),
  frame: c("#fbfaf6"),
  cloud: c("#ffffff", 1),
  chest: c("#8a5a2e"),
  gold: c("#f2b53a"),
  dark: c("#24252b"),
  screen: c("#9fd8ff", 1),
  ring: c("#f2b53a", 1),
  pot: c("#b8583a"),
  sand: c("#e6d3a3"),
  bed: c("#fbfaf6"),
  blanket: c("#3f6fb5"),
  lamp: c("#fff1c2", 1),
};

// ---------- where things are (shared with story.ts) ----------

export const ROOM = {
  laptop: [15, 11, 10] as V3, // on desk A, screen facing +z
  phone: [21.5, 11.2, 11.5] as V3, // lying on desk A
  standAt: [15, 0, 18] as V3, // where the person stands (feet), facing -z
  pcAt: [45, 0, 18] as V3, // standing spot at the PC
  monitor: [45, 17.5, 7.5] as V3, // PC monitor centre, facing +z
  window: [30, 19, -1] as V3,
};

export const ISLE = {
  discovery: [400, 0, 0] as V3,
  sendA: [500, -2, 0] as V3,
  sendB: [560, -2, 0] as V3,
  foldA: [640, 0, 40] as V3,
  foldB: [690, 0, 40] as V3,
  phone: [780, 0, 0] as V3,
  relay: [840, 45, -60] as V3,
  home: [900, 0, 0] as V3,
};

// ---------- helpers ----------

const hash = (x: number, z: number, s = 0) => {
  let h = (x * 374761393 + z * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
function noise(x: number, z: number, s: number) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c2 = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c2 - a) * v + (a - b - c2 + d) * u * v;
}

function tree(v: Voxels, x: number, y: number, z: number, h: number) {
  v.box(x, y, z, x, y + h - 1, z, B.wood);
  const top = y + h;
  for (let dx = -3; dx <= 3; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (let dz = -3; dz <= 3; dz++) {
        if (dx * dx + dy * dy * 2 + dz * dz > 11) continue;
        if (hash(x + dx, z + dz, y + dy) < 0.12) continue;
        v.set(x + dx, top + dy, z + dz, (dx + dz + dy) & 1 ? B.leaf : B.leaf2);
      }
}

/** A floating island: grass on top, dirt, then stone tapering to a point below. */
function island(v: Voxels, [cx, cy, cz]: V3, r: number, seed: number, trees = 3) {
  for (let x = -r - 3; x <= r + 3; x++)
    for (let z = -r - 3; z <= r + 3; z++) {
      const a = Math.atan2(z, x);
      const edge = r * (0.82 + 0.28 * noise(Math.cos(a) * 2 + 5, Math.sin(a) * 2 + 5, seed));
      const d = Math.hypot(x, z);
      if (d > edge) continue;
      const k = 1 - d / edge;
      const top = cy + Math.round(noise((cx + x) / 9, (cz + z) / 9, seed + 1) * 2 * k);
      const depth = Math.round(2 + Math.pow(k, 0.75) * r * 0.75 * (0.8 + 0.4 * noise(x / 4, z / 4, seed + 2)));
      for (let y = top - depth; y <= top; y++) {
        const fromTop = top - y;
        const b = fromTop === 0 ? ((x + z) & 3 ? B.grass : B.grass2) : fromTop < 3 ? B.dirt : hash(x, y, z) < 0.3 ? B.stone2 : B.stone;
        v.set(cx + x, y, cz + z, b);
      }
    }
  for (let i = 0; i < trees; i++) {
    const a = hash(i, seed, 7) * Math.PI * 2, d = r * (0.55 + 0.25 * hash(i, seed, 8));
    const x = Math.round(cx + Math.cos(a) * d), z = Math.round(cz + Math.sin(a) * d);
    let y = cy + 3;
    while (y > cy - 4 && v.get(x, y, z) === undefined) y--;
    if (v.get(x, y, z) !== undefined) tree(v, x, y + 1, z, 5 + Math.floor(hash(i, seed, 9) * 3));
  }
}

function pedestal(v: Voxels, x: number, z: number, top: number) {
  let y = top;
  while (y > top - 12 && v.get(x, y, z) === undefined) y--;
  v.box(x - 2, y + 1, z - 2, x + 2, top, z + 2, B.stone2);
  v.box(x - 3, top, z - 3, x + 3, top, z + 3, B.stone);
}

function cloud(v: Voxels, x: number, y: number, z: number, w: number, d: number, seed: number) {
  for (let i = -w; i <= w; i++)
    for (let j = -d; j <= d; j++) {
      if ((i * i) / (w * w) + (j * j) / (d * d) > 1 - 0.3 * noise(i / 3, j / 3, seed)) continue;
      v.set(x + i, y, z + j, B.cloud);
      if (noise(i / 4, j / 4, seed + 3) > 0.55) v.set(x + i, y + 1, z + j, B.cloud);
    }
}

// ---------- the bedroom ----------

function room(v: Voxels) {
  // Floor: oak planks running along x.
  for (let x = -1; x <= 60; x++) for (let z = -1; z <= 40; z++) v.set(x, -1, z, Math.floor(z / 3) % 2 ? B.oak : B.oak2);
  // Rug.
  for (let x = 20; x <= 40; x++)
    for (let z = 20; z <= 32; z++) {
      const edge = x === 20 || x === 40 || z === 20 || z === 32;
      v.set(x, 0, z, edge ? B.rug2 : B.rug);
    }
  // Walls (back and left and right), a window in the back one.
  v.box(-1, 0, -2, 60, 33, -1, B.plaster);
  v.box(-2, 0, -1, -1, 33, 40, B.plaster2);
  v.box(60, 0, -1, 61, 33, 40, B.plaster2);
  v.box(0, 0, -1, 59, 1, -1, B.skirt);
  v.clear(22, 13, -2, 37, 25, -1);
  for (let x = 21; x <= 38; x++) {
    v.set(x, 12, -1, B.frame);
    v.set(x, 26, -1, B.frame);
  }
  for (let y = 12; y <= 26; y++) {
    v.set(21, y, -1, B.frame);
    v.set(38, y, -1, B.frame);
  }
  // Desk A (standing desk, left) and desk B (the PC, right).
  for (const x0 of [6, 36]) {
    v.box(x0, 10, 6, x0 + 18, 10, 13, B.desk);
    for (const [lx, lz] of [[x0 + 1, 7], [x0 + 17, 7], [x0 + 1, 12], [x0 + 17, 12]]) v.box(lx, 0, lz, lx, 9, lz, B.metal);
  }
  // The PC tower under desk B.
  v.box(50, 0, 7, 53, 7, 11, B.dark);
  v.set(51, 6, 11, B.screen);
  // Shelf with books on the left wall.
  v.box(0, 18, 18, 3, 18, 30, B.wood);
  const books = [B.book1, B.book2, B.book3, B.book4];
  for (let z = 18; z <= 29; z++) {
    const h = 3 + Math.floor(hash(z, 1) * 3);
    if (hash(z, 2) < 0.15) continue;
    v.box(0, 19, z, 2, 18 + h, z, books[z % 4]);
  }
  // A bed along the right wall.
  v.box(46, 0, 24, 59, 3, 38, B.wood);
  v.box(46, 4, 24, 59, 4, 38, B.bed);
  v.box(46, 5, 28, 59, 5, 38, B.blanket);
  v.box(54, 5, 24, 58, 6, 26, B.bed);
  // A plant in the back corner, a floor lamp by the shelf.
  v.box(54, 0, 1, 57, 3, 4, B.pot);
  for (let y = 4; y <= 9; y++) v.set(55 + (y % 2), y, 2, B.leaf);
  v.box(53, 8, 0, 58, 11, 5, B.leaf2);
  v.box(3, 0, 3, 3, 14, 3, B.metal);
  v.box(1, 15, 1, 5, 16, 5, B.lamp);
  // Outside the window: grass, a tree, and a fence.
  for (let x = -20; x <= 80; x++) for (let z = -80; z <= -3; z++) v.set(x, -1, z, (x + z) & 3 ? B.grass : B.grass2);
  tree(v, 12, 0, -18, 7);
  tree(v, 46, 0, -26, 8);
  tree(v, 30, 0, -48, 9);
  for (let x = -20; x <= 80; x += 2) v.box(x, 0, -60, x, 2, -60, B.wood);
  v.box(-20, 2, -60, 80, 2, -60, B.wood);
}

export function buildWorld(): Voxels {
  const v = new Voxels();
  room(v);
  island(v, ISLE.discovery, 30, 1, 4);
  island(v, ISLE.sendA, 16, 2, 0);
  island(v, ISLE.sendB, 16, 3, 0);
  island(v, ISLE.foldA, 14, 4, 1);
  island(v, ISLE.foldB, 14, 5, 1);
  island(v, ISLE.phone, 22, 6, 2);
  island(v, ISLE.relay, 10, 7, 0);
  island(v, ISLE.home, 14, 8, 0);

  const [dx, , dz] = ISLE.discovery;
  pedestal(v, dx, dz, 2);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    pedestal(v, Math.round(dx + Math.cos(a) * 20), Math.round(dz + Math.sin(a) * 20), 2);
  }
  pedestal(v, ISLE.sendA[0], ISLE.sendA[2], 1);
  pedestal(v, ISLE.sendB[0], ISLE.sendB[2], 1);
  pedestal(v, ISLE.home[0], ISLE.home[2], 2);

  // The folder islands: the chest on A, an empty plinth on B.
  const [fx, , fz] = ISLE.foldA;
  v.box(fx - 4, 1, fz - 2, fx + 4, 4, fz + 2, B.chest);
  v.box(fx - 4, 2, fz + 2, fx + 4, 2, fz + 2, B.gold);
  v.set(fx, 3, fz + 2, B.gold);
  v.box(ISLE.foldB[0] - 4, 1, ISLE.foldB[2] - 2, ISLE.foldB[0] + 4, 1, ISLE.foldB[2] + 2, B.stone);

  // A giant phone standing on the phone island; its screen glows. A flat
  // stone floor in front of it for the QR code.
  const [px, , pz] = ISLE.phone;
  v.clear(px - 12, 3, pz + 2, px + 12, 24, pz + 26);
  v.box(px - 12, 2, pz + 2, px + 12, 2, pz + 26, B.stone);
  v.box(px - 7, 1, pz - 10, px + 7, 26, pz - 9, B.dark);
  v.box(px - 6, 3, pz - 8, px + 6, 24, pz - 8, B.screen);
  // The relay tower: stone column, a glowing ring near the top.
  const [rx, ry, rz] = ISLE.relay;
  v.box(rx - 2, ry + 1, rz - 2, rx + 2, ry + 30, rz + 2, B.stone2);
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * Math.PI * 2;
    v.set(Math.round(rx + Math.cos(t) * 6), ry + 28, Math.round(rz + Math.sin(t) * 6), B.ring);
  }
  v.box(rx, ry + 31, rz, rx, ry + 36, rz, B.metal);

  // Clouds, below and above the islands.
  for (let i = 0; i < 26; i++) {
    const x = 330 + hash(i, 1, 3) * 640, z = -140 + hash(i, 2, 3) * 260;
    const y = hash(i, 3, 3) < 0.5 ? -34 - Math.floor(hash(i, 4, 3) * 10) : 58 + Math.floor(hash(i, 5, 3) * 12);
    cloud(v, Math.round(x), y, Math.round(z), 8 + Math.floor(hash(i, 6, 3) * 8), 5 + Math.floor(hash(i, 7, 3) * 5), i);
  }
  // Clouds over the house, for the ending.
  for (let i = 0; i < 8; i++) cloud(v, Math.round(-60 + hash(i, 8, 3) * 180), 46 + (i % 3) * 4, Math.round(-90 - hash(i, 9, 3) * 140), 10, 6, i + 40);
  return v;
}
