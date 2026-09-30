// What happens when: the camera path, the lighting, and every moving thing
// (the person, devices, flying chunks, keys, rings, the logo) as a pure
// function of time. Times match web/film/timeline.json and its cues.

import type { Cube, Frame, RGB, V3 } from "./engine";
import { add, lerp3, sub } from "./engine";
import { ISLE, ROOM } from "./world";

// ---------- small helpers ----------

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => {
  const k = clamp(x);
  return k * k * (3 - 2 * k);
};
/** 0 before a, 1 after b, eased in between. */
const span = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const easeOutBack = (x: number) => {
  const k = clamp(x) - 1;
  return 1 + 2.2 * k * k * k + 1.2 * k * k;
};
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const rnd = (i: number, s = 0) => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(s + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const C = {
  skin: hex("#f2c29b"),
  hair: hex("#3a2618"),
  hoodie: hex("#e8a317"),
  hoodie2: hex("#cf8f10"),
  pants: hex("#3b4a6b"),
  shoe: hex("#2a2a2e"),
  eye: hex("#1d1b18"),
  body: hex("#2b2d34"),
  silver: hex("#c9ccd3"),
  screen: hex("#9fd8ff"),
  screenDim: hex("#35506a"),
  file: hex("#f2b53a"),
  sealed: hex("#8a5f00"),
  gold: hex("#ffd36b"),
  paper: hex("#fbfaf6"),
  green: hex("#3fae6b"),
  shu: hex("#e5594b"),
  dark: hex("#1d1b18"),
  key: hex("#f2b53a"),
};

type Out = Cube[];

/** Rotate local points about the y axis (yaw 0 faces -z) and move them to `at`. */
function place(parts: Cube[], at: V3, yaw: number, out: Out) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const p of parts) {
    const [x, y, z] = p.p;
    out.push({ ...p, p: [at[0] + x * c + z * s, at[1] + y, at[2] - x * s + z * c], ry: (p.ry ?? 0) + yaw });
  }
}

// ---------- people and devices (local space: y up, facing -z) ----------

interface Pose {
  walk?: number; // phase in radians; legs and arms swing
  walking?: number; // 0..1 how much
  headYaw?: number;
  typing?: number; // 0..1
  think?: number; // 0..1: right hand to the chin
  reach?: number; // 0..1: right arm reaching forward (clicking)
  cheer?: number; // 0..1: both arms up
}

function person(feet: V3, yaw: number, pose: Pose, t: number, out: Out) {
  const parts: Cube[] = [];
  const sw = Math.sin(pose.walk ?? 0) * 0.6 * (pose.walking ?? 0);
  // Legs swing about the hip (y = 6).
  for (const side of [-1, 1]) {
    const a = sw * side;
    parts.push({ p: [side * 1.1, 6 - 3 * Math.cos(a), -3 * Math.sin(a)], s: [2, 6, 2], c: C.pants, rx: a });
    parts.push({ p: [side * 1.1, 6 - 5.6 * Math.cos(a), -5.6 * Math.sin(a) - 0.3], s: [2.1, 0.9, 2.6], c: C.shoe, rx: a });
  }
  const breathe = Math.sin(t * 2.1) * 0.08;
  parts.push({ p: [0, 9 + breathe, 0], s: [5, 6, 3], c: C.hoodie });
  parts.push({ p: [0, 12 + breathe, 1.3], s: [3.5, 1, 1], c: C.hoodie2 }); // hood
  // Arms swing about the shoulder (y = 12).
  const typing = (pose.typing ?? 0) * (0.45 + Math.sin(t * 18) * 0.05);
  for (const side of [-1, 1]) {
    let a = -sw * side + typing;
    if (side === 1) a = Math.max(a, (pose.think ?? 0) * 2.5, (pose.reach ?? 0) * 1.25);
    a = Math.max(a, (pose.cheer ?? 0) * 2.9);
    parts.push({ p: [side * 3.5, 12 + breathe - 3 * Math.cos(a), -3 * Math.sin(a)], s: [2, 6, 2], c: C.hoodie, rx: a });
    parts.push({ p: [side * 3.5, 12 + breathe - 6.2 * Math.cos(a), -6.2 * Math.sin(a)], s: [1.9, 0.9, 1.9], c: C.skin, rx: a });
  }
  // Head (turns on its own).
  const hy = pose.headYaw ?? 0;
  const head: Cube[] = [
    { p: [0, 0, 0], s: [5, 5, 5], c: C.skin },
    { p: [0, 2.2, 0.3], s: [5.3, 1.2, 5.3], c: C.hair },
    { p: [0, 0.8, 2.3], s: [5.3, 3.4, 1], c: C.hair },
    { p: [-1.1, 0.2, -2.55], s: [0.8, 0.9, 0.2], c: C.eye },
    { p: [1.1, 0.2, -2.55], s: [0.8, 0.9, 0.2], c: C.eye },
  ];
  const headAt: V3 = [0, 14.6 + breathe, 0];
  place(head, headAt, hy, parts);
  place(parts, feet, yaw, out);
}

/** Laptop, screen facing local +z, base centred on `at`. */
function laptop(at: V3, yaw: number, lit: number, out: Out, glyph = true) {
  const a = 0.28; // screen tilt back
  const parts: Cube[] = [{ p: [0, 0.3, 0], s: [8, 0.6, 5.6], c: C.silver }];
  const hinge: V3 = [0, 0.6, -2.8];
  const mid: V3 = [0, hinge[1] + 2.7 * Math.cos(a), hinge[2] - 2.7 * Math.sin(a)];
  parts.push({ p: mid, s: [8, 5.4, 0.35], c: C.silver, rx: -a });
  const n: V3 = [0, Math.sin(a), Math.cos(a)];
  const scr = lerp3(C.screenDim, C.screen, lit);
  parts.push({ p: add(mid, [n[0] * 0.2, n[1] * 0.2, n[2] * 0.2]), s: [7.2, 4.6, 0.05], c: scr, e: 1, rx: -a });
  if (glyph) parts.push({ p: add(mid, [0, n[1] * 0.3, n[2] * 0.3]), s: [1.6, 2, 0.05], c: C.file, e: lit, rx: -a });
  place(parts, at, yaw, out);
}

/** Desktop monitor, screen facing local +z, centred on `at`. */
function monitor(at: V3, yaw: number, screen: RGB, out: Out) {
  const parts: Cube[] = [
    { p: [0, 0, 0], s: [12, 7.5, 0.6], c: C.body },
    { p: [0, 0, 0.32], s: [11.2, 6.8, 0.05], c: screen, e: 1 },
    { p: [0, -5, -0.6], s: [1.2, 3, 0.8], c: C.body },
    { p: [0, -6.4, -0.3], s: [5, 0.4, 3], c: C.body },
  ];
  place(parts, at, yaw, out);
}

function phoneUp(at: V3, yaw: number, lit: number, out: Out, s = 1) {
  place(
    [
      { p: [0, 3 * s, 0], s: [3 * s, 6 * s, 0.5 * s], c: C.body },
      { p: [0, 3 * s, 0.27 * s], s: [2.6 * s, 5.4 * s, 0.05], c: lerp3(C.screenDim, C.screen, lit), e: 1 },
    ],
    at,
    yaw,
    out,
  );
}

/** A file made of chunks; sealed chunks are darker with a glowing lock. */
function chunk(p: V3, size: number, sealed: number, out: Out) {
  const body = lerp3(C.file, C.sealed, sealed);
  out.push({ p, s: [size, size, size], c: body });
  if (sealed > 0.05) out.push({ p: [p[0], p[1] + size * 0.5, p[2]], s: [size * 0.45 * sealed, size * 0.12, size * 0.45 * sealed], c: C.gold, e: 1 });
}

/** Chunk layout of a file: 5 wide x 6 tall, the top right corner folded. */
const FILE_CELLS: [number, number][] = [];
for (let y = 0; y < 6; y++) for (let x = 0; x < 5; x++) if (!(x === 4 && y === 5)) FILE_CELLS.push([x, y]);
const fileCell = (i: number, at: V3, k = 1): V3 => [at[0] + (FILE_CELLS[i][0] - 2) * k, at[1] + FILE_CELLS[i][1] * k, at[2]];

function wholeFile(at: V3, out: Out, glow = 0) {
  FILE_CELLS.forEach((_, i) => out.push({ p: fileCell(i, at), s: [1, 1, 1], c: C.file, e: glow }));
  out.push({ p: [at[0] + 1.8, at[1] + 4.8, at[2]], s: [0.6, 0.6, 1], c: C.paper });
}

const arc = (a: V3, b: V3, h: number, u: number): V3 => {
  const p = lerp3(a, b, u);
  return [p[0], p[1] + h * 4 * u * (1 - u), p[2]];
};

/** A file tossed from a to b as sealed chunks, between t0 and t1. */
function toss(t: number, t0: number, t1: number, a: V3, b: V3, h: number, out: Out, lateral: V3 = [0, 0, 1]) {
  const n = FILE_CELLS.length;
  const spacing = (t1 - t0 - 1.8) / n;
  for (let i = 0; i < n; i++) {
    const s0 = t0 + i * spacing, s1 = s0 + 1.8;
    const from = fileCell(i, a), to = fileCell(i, b);
    if (t < s0) {
      chunk(from, 0.95, span(t, t0 - 0.6, t0), out);
    } else if (t < s1) {
      const u = smooth((t - s0) / (s1 - s0));
      const wob = Math.sin(u * Math.PI) * (rnd(i, 3) - 0.5) * 3;
      const p = add(arc(from, to, h, u), [lateral[0] * wob, lateral[1] * wob, lateral[2] * wob]);
      chunk(p, 0.85, 1, out);
    } else {
      chunk(to, 0.95, 1 - span(t, t1, t1 + 0.5), out);
    }
  }
}

/** A green ring spreading on the ground, and a check mark popping above. */
function checked(t: number, t0: number, at: V3, out: Out, r = 7, ground?: number) {
  const k = t - t0;
  if (k < 0 || k > 3) return;
  const rr = r * easeOutBack(k / 0.6);
  const size = 0.9 * (1 - span(k, 1.2, 2.2));
  const gy = ground ?? at[1] - 1;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    out.push({ p: [at[0] + Math.cos(a) * rr, gy, at[2] + Math.sin(a) * rr], s: [size, size * 0.5, size], c: C.green, e: 1 });
  }
  const pop = easeOutBack(k / 0.4) * (1 - span(k, 2.2, 2.8));
  const pts: [number, number][] = [[-2, 0], [-1, -1], [0, -2], [1, -1], [2, 0], [3, 1], [4, 2]];
  for (const [x, y] of pts) out.push({ p: [at[0] + x * 0.9 * pop, at[1] + 8 + y * 0.9 * pop, at[2]], s: [pop, pop, pop], c: C.green, e: 1 });
}

// ---------- the scenes ----------

function roomScene(t: number, out: Out) {
  // The laptop and the phone on desk A, the monitor on desk B.
  laptop(ROOM.laptop, 0, 1, out);
  const buzz = t > 13.5 && t < 14.1 ? Math.sin(t * 90) * 0.15 : 0;
  const lit = span(t, 13.5, 13.7) * (1 - span(t, 21, 22));
  out.push({ p: [ROOM.phone[0] + buzz, ROOM.phone[1], ROOM.phone[2]], s: [2.4, 0.35, 4.6], c: C.body });
  out.push({ p: [ROOM.phone[0] + buzz, ROOM.phone[1] + 0.2, ROOM.phone[2]], s: [2.1, 0.05, 4.2], c: lerp3(C.screenDim, C.screen, lit), e: 1 });
  const arrived = span(t, 73, 73.3) * (1 - span(t, 76, 77));
  monitor(ROOM.monitor, 0, lerp3(C.screen, hex("#bff0cf"), arrived), out);
  out.push({ p: [45, 11.2, 12], s: [7, 0.4, 2], c: C.body }); // keyboard

  // The person: at the laptop, then walks to the PC.
  let feet: V3 = ROOM.standAt, yaw = 0;
  const pose: Pose = { typing: span(t, 1, 1.5) * (1 - span(t, 4.5, 5)) };
  pose.think = span(t, 5.2, 5.8) * (1 - span(t, 12.6, 13.2));
  pose.headYaw = -0.9 * span(t, 11.8, 12.4) * (1 - span(t, 13.2, 13.6)) - 0.55 * span(t, 13.8, 14.2);
  if (t > 66) {
    pose.headYaw = 0;
    pose.think = 0;
    pose.typing = span(t, 66.3, 66.6) * (1 - span(t, 67.4, 67.7));
    const w = clamp((t - 67.8) / 1.8);
    feet = lerp3(ROOM.standAt, ROOM.pcAt, smooth(w));
    const turning = span(t, 67.6, 67.9) * (1 - span(t, 69.5, 69.9));
    yaw = -Math.PI / 2 * turning;
    pose.walking = w > 0 && w < 1 ? 1 : 0;
    pose.walk = (t - 67.8) * 11;
    pose.reach = span(t, 69.7, 69.95) * (1 - span(t, 70.3, 70.7));
    const j = t - 73.5;
    if (j > 0 && j < 1.1) feet = [feet[0], Math.max(0, Math.sin((j / 0.55) * Math.PI)) * 3.5, feet[2]];
    pose.cheer = span(t, 73.4, 73.6) * (1 - span(t, 74.6, 75.1));
  }
  person(feet, yaw, pose, t, out);

  // The file on the laptop screen flies over to the PC once accepted.
  if (t > 70 && t < 74) {
    toss(t, 70.3, 72.9, [15, 13, 9], [45, 15, 8.6], 13, out);
  }
  checked(t, 73.0, [45, 15, 12], out, 6, 11.4);
  return { head: add(feet, [0, 18.5, 0]) as V3 };
}

const DEV_ANGLES = [0, 1, 2, 3].map((i) => (i / 4) * Math.PI * 2 + 0.4);
const PINGS = [23.5, 25.0, 26.5];

function discovery(t: number, out: Out) {
  const [cx, , cz] = ISLE.discovery;
  const top = 3;
  laptop([cx, top, cz], 0, 1, out);
  // Pulses spreading from my laptop.
  for (const p of PINGS) {
    const k = t - p;
    if (k < 0 || k > 1.8) continue;
    const r = k * 16;
    const s = 1.1 * (1 - k / 1.8);
    const n = Math.max(12, Math.floor(r * 2.2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push({ p: [cx + Math.cos(a) * r, top + 1, cz + Math.sin(a) * r], s: [s, s * 0.6, s], c: C.key, e: 1 });
    }
  }
  // The devices around light up as the pulses reach them.
  DEV_ANGLES.forEach((a, i) => {
    const at: V3 = [Math.round(cx + Math.cos(a) * 20), top, Math.round(cz + Math.sin(a) * 20)];
    const face = Math.atan2(at[0] - cx, at[2] - cz); // turn to face the middle
    const litAt = PINGS[Math.min(i, 2)] + 1.25;
    const lit = span(t, litAt, litAt + 0.3);
    if (i === 0) monitor([at[0], top + 6.6, at[2]], face + Math.PI, lerp3(C.screenDim, C.screen, lit), out);
    else if (i === 1) laptop(at, face + Math.PI, lit, out, false);
    else if (i === 2) phoneUp(at, face + Math.PI, lit, out, 1.2);
    else phoneUp(at, face + Math.PI, lit, out, 1.9);
    // A beam of light over each found device.
    if (lit > 0) for (let y = 0; y < 8; y++) out.push({ p: [at[0], top + 12 + y * 1.6, at[2]], s: [0.5 * lit, 1.2, 0.5 * lit], c: C.key, e: 1 });
  });
}

function send(t: number, out: Out) {
  const a: V3 = [ISLE.sendA[0], 2, ISLE.sendA[2]], b: V3 = [ISLE.sendB[0], 2, ISLE.sendB[2]];
  laptop(a, Math.PI / 2, 1, out, false);
  monitor([b[0], 8.6, b[2]], -Math.PI / 2, lerp3(C.screen, hex("#bff0cf"), span(t, 43.5, 43.8)), out);
  const mid: V3 = [(a[0] + b[0]) / 2, 16, 0];
  // Two keys fly in and turn into one lock (the TLS handshake).
  if (t > 31 && t < 35.5) {
    const k = span(t, 31.4, 32.5);
    const fade = 1 - span(t, 34.6, 35.2);
    for (const side of [-1, 1]) {
      const from: V3 = side < 0 ? [a[0] + 2, 7, 0] : [b[0] - 2, 7, 0];
      const p = lerp3(from, [mid[0] + side * 3.2, mid[1], 0], k);
      const spin = (1 - k) * 6 * side;
      if (t < 33.5) {
        const key: Cube[] = [
          { p: [side * 3, 0, 0], s: [3.2, 3.2, 1], c: C.key },
          { p: [-side * 1, 0, 0], s: [5, 1, 1], c: C.key },
          { p: [-side * 2.8, -1.2, 0], s: [1, 1.6, 1], c: C.key },
        ];
        place(key, p, spin, out);
      }
    }
    if (t > 32.5) {
      // The lock: body, and a shackle that drops shut at 33.5.
      const pop = easeOutBack((t - 32.5) / 0.4) * fade;
      const drop = span(t, 33.2, 33.5) * 0.9;
      const lockCol = lerp3(C.key, C.gold, span(t, 33.5, 33.7));
      const L = 2 * pop;
      out.push({ p: mid, s: [3.4 * L, 2.8 * L, 1.2 * L], c: lockCol, e: span(t, 33.5, 33.7) * 0.6 });
      out.push({ p: [mid[0], mid[1] - 0.2 * L, 0.65 * L], s: [0.6 * L, 1 * L, 0.1], c: C.dark });
      for (const x of [-1.1, 1.1]) out.push({ p: [mid[0] + x * L, mid[1] + (2.3 - drop) * L, 0], s: [0.5 * L, 1.8 * L, 0.5 * L], c: C.silver });
      out.push({ p: [mid[0], mid[1] + (3.2 - drop) * L, 0], s: [2.7 * L, 0.5 * L, 0.5 * L], c: C.silver });
    }
  }
  // The sealed path over the gap: dots light up from A to B.
  const from: V3 = [a[0] + 3, 7, 0], to: V3 = [b[0] - 3, 7, 0];
  const lay = span(t, 33.6, 35);
  const dim = 1 - span(t, 44, 45);
  for (let i = 0; i <= 30; i++) {
    const u = i / 30;
    if (u > lay || dim <= 0) continue;
    out.push({ p: arc(from, to, 14, u), s: [0.35 * dim, 0.35 * dim, 0.35 * dim], c: C.gold, e: 1 });
  }
  // The file: whole on A, sealed chunks over the gap, whole again on B.
  if (t < 35) wholeFile(from, out, span(t, 33.5, 35) * 0.3);
  else if (t < 44.2) toss(t, 35, 43.4, from, to, 14, out);
  if (t > 43.4) wholeFile(to, out, 0.3 * (1 - span(t, 44, 45)));
  checked(t, 43.5, [to[0], to[1], to[2]], out, 7, 1.6);
}

type Node = { kind: "folder" | "file"; rel: V3; parent: number };
const TREE: Node[] = [
  { kind: "folder", rel: [0, 11, 0], parent: -1 },
  { kind: "folder", rel: [-5, 7, 0], parent: 0 },
  { kind: "folder", rel: [5, 7, 0], parent: 0 },
  { kind: "file", rel: [-7, 3, 0], parent: 1 },
  { kind: "file", rel: [-3.5, 3, 0], parent: 1 },
  { kind: "file", rel: [2.5, 3, 0], parent: 2 },
  { kind: "file", rel: [5, 3, 0], parent: 2 },
  { kind: "file", rel: [7.5, 3, 0], parent: 2 },
];

function nodeCubes(n: Node, p: V3, out: Out) {
  if (n.kind === "folder") {
    out.push({ p, s: [3.2, 2.4, 0.8], c: C.file });
    out.push({ p: [p[0] - 0.8, p[1] + 1.4, p[2]], s: [1.4, 0.5, 0.8], c: C.file });
  } else {
    out.push({ p, s: [1.8, 2.4, 0.4], c: C.paper });
    out.push({ p: [p[0] + 0.55, p[1] + 0.95, p[2] + 0.05], s: [0.6, 0.6, 0.4], c: C.file });
  }
}

function rod(a: V3, b: V3, out: Out) {
  const d = sub(b, a);
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 0.01) return;
  const rx = Math.acos(clamp(d[1] / len, -1, 1));
  const ry = Math.atan2(d[0], d[2]);
  out.push({ p: lerp3(a, b, 0.5), s: [0.22, len, 0.22], c: C.gold, e: 0.4, rx, ry });
}

function folders(t: number, out: Out) {
  const [ax, , az] = ISLE.foldA;
  const [bx, , bz] = ISLE.foldB;
  // The chest lid opens about its back edge.
  const open = span(t, 47, 47.6) * 1.9;
  // Hinge on the back top edge; the lid swings up and back.
  const hinge: V3 = [ax + 0.5, 5, az - 2];
  const ly = 0.6 * Math.cos(open) + 2.5 * Math.sin(open), lz = -0.6 * Math.sin(open) + 2.5 * Math.cos(open);
  out.push({ p: [hinge[0], hinge[1] + ly, hinge[2] + lz], s: [9.2, 1.2, 5.2], c: hex("#6f4522"), rx: -open });
  const baseA: V3 = [ax, 3, az], baseB: V3 = [bx, 2, bz];
  const pos: V3[] = TREE.map((n, i) => {
    const up = span(t, 48 + i * 0.12, 48.9 + i * 0.12);
    const inA = lerp3(baseA, add(baseA, n.rel), up);
    const s0 = 49.6 + i * 0.28, s1 = s0 + 1.7;
    if (t < s0) return inA;
    const u = smooth((t - s0) / (s1 - s0));
    return arc(add(baseA, n.rel), add(baseB, n.rel), 10, u);
  });
  const visible = t > 48;
  if (visible) TREE.forEach((n, i) => nodeCubes(n, pos[i], out));
  // Branches, only while the tree stands still (in the chest's air, or landed).
  const still = (t > 49 && t < 49.6) || t > 53.4;
  if (visible && still) TREE.forEach((n, i) => n.parent >= 0 && rod(pos[n.parent], pos[i], out));
  checked(t, 53.5, add(baseB, [0, 2, 0]), out, 8, 2.2);
}

// QR: 21x21 with the three finder squares, the rest a fixed pseudo-random pattern.
const QR: boolean[] = [];
for (let y = 0; y < 21; y++)
  for (let x = 0; x < 21; x++) {
    const finder = (fx: number, fy: number) => {
      const dx = x - fx, dy = y - fy;
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
      const r = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      return r !== 2;
    };
    const f = finder(0, 0) ?? finder(14, 0) ?? finder(0, 14);
    QR.push(f ?? rnd(y * 21 + x, 11) < 0.48);
  }

function phones(t: number, out: Out) {
  const [px, , pz] = ISLE.phone;
  // The QR code builds on the stone floor, tile by tile.
  for (let i = 0; i < 441; i++) {
    const at = 56.5 + rnd(i, 5) * 0.9;
    const k = span(t, at, at + 0.15);
    if (k <= 0) continue;
    const x = px - 10 + (i % 21), z = pz + 4 + Math.floor(i / 21);
    const flash = span(t, 58.3, 58.45) * (1 - span(t, 58.8, 59.4));
    const col = QR[i] ? lerp3(C.dark, C.file, flash) : C.paper;
    out.push({ p: [x + 0.5, 3.1, z + 0.5], s: [0.96 * k, 0.2, 0.96 * k], c: col, e: QR[i] ? flash : 0.3 });
  }
  // The phone scans it: a bar of light sweeps from the phone over the code.
  if (t > 57.5 && t < 58.4) {
    const z = pz + 3 + span(t, 57.5, 58.3) * 22;
    for (let x = -11; x <= 11; x++) out.push({ p: [px + x + 0.5, 3.6, z], s: [1, 0.3, 0.5], c: C.screen, e: 1 });
  }
  // A check on the giant phone's screen once paired.
  const ok = span(t, 58.3, 58.6);
  if (ok > 0) {
    const pts: [number, number][] = [[-3, 0], [-2, -1], [-1, -2], [0, -1], [1, 0], [2, 1], [3, 2]];
    for (const [x, y] of pts) out.push({ p: [px + x * 1.4, 14 + y * 1.4, pz - 7.6], s: [1.3 * ok, 1.3 * ok, 0.2], c: C.green, e: 1 });
  }
  // Sealed packets: phone → relay tower → the computer at home.
  const [rx, ry, rz] = ISLE.relay;
  const [hx, , hz] = ISLE.home;
  laptop([hx, 3, hz], Math.PI * 0.25, 1, out, false);
  const p0: V3 = [px, 27, pz - 9], p1: V3 = [rx, ry + 28, rz], p2: V3 = [hx, 6, hz];
  for (let i = 0; i < 10; i++) {
    const s0 = 60 + i * 0.16, s1 = s0 + 2.5;
    if (t < s0 || t > s1) continue;
    const u = (t - s0) / (s1 - s0);
    const p = u < 0.5 ? arc(p0, p1, 12, smooth(u * 2)) : arc(p1, p2, 10, smooth(u * 2 - 1));
    chunk(p, 2.4, 1, out);
  }
  checked(t, 64.0, [hx, 6, hz], out, 7, 3.2);
}

// ---------- the logo in the sky ----------

const FONT: Record<string, string[]> = {
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  n: ["00000", "00000", "10110", "11001", "10001", "10001", "10001"],
};
const LOGO_AT: V3 = [30, 95, -150];
const LOGO: { p: V3; c: RGB; order: number }[] = [];
{
  const bs = 3;
  const left = LOGO_AT[0] - 14 * bs; // icon (9) + gap (2) + "Yon" (17) = 28 columns, centred
  // The app icon: a marigold tile with a dark file on it.
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const corner = (x === 0 || x === 8) && (y === 0 || y === 8);
      if (corner) continue;
      const file = x >= 3 && x <= 6 && y >= 2 && y <= 6 && !(x === 6 && y === 6);
      LOGO.push({ p: [left + x * bs, LOGO_AT[1] + (8 - y) * bs - 12, LOGO_AT[2]], c: file ? C.dark : C.file, order: x });
    }
  let ox = 11;
  for (const ch of "Yon") {
    FONT[ch].forEach((row, y) =>
      [...row].forEach((v, x) => {
        if (v === "1") LOGO.push({ p: [left + (ox + x) * bs, LOGO_AT[1] + (6 - y) * bs - 10, LOGO_AT[2]], c: C.paper, order: ox + x });
      }),
    );
    ox += 6;
  }
}

function logo(t: number, out: Out) {
  if (t < 78.5) return;
  const glow = span(t, 84, 84.6) * (0.5 + 0.1 * Math.sin(t * 3));
  LOGO.forEach((b, i) => {
    const at = 79 + (b.order / 28) * 4 + rnd(i, 9) * 0.4;
    const k = clamp((t - at) / 1.1);
    if (k <= 0) return;
    const from: V3 = [b.p[0] + (rnd(i, 1) - 0.5) * 80, b.p[1] - 60 - rnd(i, 2) * 40, b.p[2] + 30 + rnd(i, 3) * 40];
    const e = easeOutBack(k);
    const p = lerp3(from, b.p, e);
    out.push({ p, s: [2.9, 2.9, 2.9], c: b.c, e: glow, rx: (1 - k) * 4, ry: (1 - k) * 3 });
  });
}

// ---------- camera ----------

interface Key {
  t: number;
  eye: V3;
  look: V3;
  fov?: number;
  cut?: boolean; // a new shot starts here (hidden by a wipe)
}
const KEYS: Key[] = [
  { t: 0, eye: [58, 34, 66], look: [24, 10, 12], fov: 42 },
  { t: 4, eye: [46, 28, 52], look: [20, 12, 12] },
  { t: 7, eye: [34, 24, 42], look: [17, 16, 14] },
  { t: 10.5, eye: [30, 23, 40], look: [22, 15, 12] },
  { t: 12.6, eye: [32, 25, 46], look: [34, 13, 10] },
  { t: 14.5, eye: [30, 22, 32], look: [21, 12, 12] },
  { t: 17.5, eye: [25, 18, 21], look: [21.5, 11, 11.8], fov: 40 },
  { t: 19.6, eye: [21.6, 14.5, 12.8], look: [21.5, 11, 11.6], fov: 34 },
  { t: 20.5, eye: [21.5, 12.4, 11.9], look: [21.5, 11, 11.5], fov: 30 },

  { t: 20.5, eye: [330, 72, 116], look: [400, 8, 0], fov: 50, cut: true },
  { t: 23.5, eye: [358, 40, 72], look: [400, 6, 0], fov: 48 },
  { t: 27, eye: [385, 28, 50], look: [400, 5, 0], fov: 46 },
  { t: 30.5, eye: [440, 26, 46], look: [420, 6, 0] },
  { t: 31.5, eye: [522, 26, 66], look: [530, 13, 0] },
  { t: 33.5, eye: [526, 22, 46], look: [530, 15, 0] },
  { t: 35.5, eye: [505, 16, 26], look: [512, 11, 0] },
  { t: 38, eye: [522, 26, 24], look: [530, 19, 0] },
  { t: 40.5, eye: [540, 26, 24], look: [546, 16, 0] },
  { t: 43.5, eye: [546, 16, 26], look: [557, 8, 0] },
  { t: 45.5, eye: [604, 26, 74], look: [640, 8, 40] },
  { t: 47, eye: [640, 15, 62], look: [641, 6, 40] },
  { t: 49.5, eye: [660, 26, 86], look: [662, 13, 40] },
  { t: 52, eye: [678, 22, 82], look: [684, 11, 40] },
  { t: 54, eye: [702, 18, 70], look: [690, 8, 40] },
  { t: 55.5, eye: [758, 30, 52], look: [780, 12, 6] },
  { t: 57.5, eye: [770, 26, 40], look: [780, 4, 14] },
  { t: 58.8, eye: [781, 22, 40], look: [780, 12, -6] },
  { t: 60.2, eye: [800, 42, 30], look: [822, 52, -30] },
  { t: 61.8, eye: [826, 76, -18], look: [840, 73, -60] },
  { t: 63.6, eye: [890, 18, 24], look: [900, 5, 0] },
  { t: 66, eye: [893, 14, 17], look: [900, 5, 0] },

  { t: 66, eye: [26, 26, 50], look: [18, 12, 12], fov: 42, cut: true },
  { t: 68.5, eye: [40, 25, 48], look: [32, 13, 12] },
  { t: 70, eye: [49, 23, 40], look: [44, 15, 10] },
  { t: 71.5, eye: [32, 30, 58], look: [30, 13, 10] },
  { t: 73.5, eye: [40, 22, 44], look: [44, 13, 14] },
  { t: 76, eye: [38, 22, 40], look: [32, 17, 6] },
  { t: 77.5, eye: [34, 20, 26], look: [30, 19, -4] },
  { t: 79, eye: [30, 19, 4], look: [30, 21, -20], fov: 50 },
  { t: 80, eye: [30, 22, -10], look: [30, 40, -60] },
  { t: 83, eye: [30, 58, -46], look: [30, 90, -150], fov: 46 },
  { t: 86, eye: [30, 64, -54], look: [30, 93, -150] },
  { t: 90, eye: [30, 67, -62], look: [30, 94, -150] },
];

function camera(t: number): { eye: V3; look: V3; fov: number } {
  // The shot this time falls in: keys from the last cut up to the next one.
  let start = 0;
  for (let i = 0; i < KEYS.length; i++) if (KEYS[i].cut && KEYS[i].t <= t) start = i;
  let end = start;
  while (end + 1 < KEYS.length && !KEYS[end + 1].cut) end++;
  const shot = KEYS.slice(start, end + 1);
  let i = 0;
  while (i < shot.length - 2 && t >= shot[i + 1].t) i++;
  const k0 = shot[Math.max(0, i - 1)], k1 = shot[i], k2 = shot[Math.min(shot.length - 1, i + 1)], k3 = shot[Math.min(shot.length - 1, i + 2)];
  const u = k2.t > k1.t ? clamp((t - k1.t) / (k2.t - k1.t)) : 0;
  const cr = (a: V3, b: V3, c: V3, d: V3): V3 => {
    const u2 = u * u, u3 = u2 * u;
    const f = (p0: number, p1: number, p2: number, p3: number) =>
      0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    return [f(a[0], b[0], c[0], d[0]), f(a[1], b[1], c[1], d[1]), f(a[2], b[2], c[2], d[2])];
  };
  const fovOf = (k: Key, j: number): number => {
    for (let n = j; n >= 0; n--) if (shot[n].fov) return shot[n].fov!;
    return k.fov ?? 45;
  };
  const f1 = fovOf(k1, i), f2 = fovOf(k2, Math.min(shot.length - 1, i + 1));
  return { eye: cr(k0.eye, k1.eye, k2.eye, k3.eye), look: cr(k0.look, k1.look, k2.look, k3.look), fov: f1 + (f2 - f1) * smooth(u) };
}

// ---------- the frame ----------

const ROOM_LIGHT = {
  light: hex("#fff1dc"),
  fog: hex("#f3e6d2"),
  fogDensity: 0.0025,
  skyTop: hex("#8fc3ea"),
  skyBottom: hex("#fbe3c0"),
};
const SKY_LIGHT = {
  light: hex("#fffaf0"),
  fog: hex("#cfe6f5"),
  fogDensity: 0.0034,
  skyTop: hex("#4f93d8"),
  skyBottom: hex("#cfe6f5"),
};

export interface Shot {
  frame: Frame;
  /** World points the 2D layer anchors to, when they matter. */
  head: V3 | null;
  pcScreen: V3 | null;
}

export function shot(t: number, duration: number): Shot {
  const cubes: Cube[] = [];
  const inRoom = t < 20.5 || (t >= 66 && t < 79.5);
  let head: V3 | null = null;
  if (t < 20.5 || t >= 66) head = roomScene(t, cubes).head;
  if (t >= 20.5 && t < 31.5) discovery(t, cubes);
  if (t >= 30 && t < 46.5) send(t, cubes);
  if (t >= 44 && t < 56.5) folders(t, cubes);
  if (t >= 54 && t < 66) phones(t, cubes);
  logo(t, cubes);

  const cam = camera(t);
  const out = t >= 79.5 ? SKY_LIGHT : inRoom ? ROOM_LIGHT : SKY_LIGHT;
  const outro = span(t, 79, 81);
  const L = <K extends keyof typeof ROOM_LIGHT>(k: K) => {
    if (t < 79 || t >= 81) return out[k];
    const a = ROOM_LIGHT[k], b = SKY_LIGHT[k];
    return (typeof a === "number" ? a + ((b as number) - a) * outro : lerp3(a as RGB, b as RGB, outro)) as (typeof ROOM_LIGHT)[K];
  };
  const wipe = (c: number) => smooth(1 - Math.abs(t - c) / 0.5);
  return {
    frame: {
      eye: cam.eye,
      look: cam.look,
      fov: cam.fov,
      cubes,
      light: L("light"),
      fog: L("fog"),
      fogDensity: L("fogDensity"),
      skyTop: L("skyTop"),
      skyBottom: L("skyBottom"),
      fade: Math.min(1, t / 1.2, Math.max(0, (duration - t) / 2)),
      wipe: Math.max(wipe(20.5), wipe(66)),
    },
    head: t < 13.5 ? head : null,
    pcScreen: t > 68 && t < 77 ? [ROOM.monitor[0], ROOM.monitor[1], ROOM.monitor[2] + 1] : null,
  };
}
