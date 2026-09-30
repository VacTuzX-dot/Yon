// 2D overlay for the Yon film: captions (crisp), pixel-art thought bubbles, chat notifications,
// and the Accept dialog on the PC. Pure function of (t, anchors, scale). No timers, no randomness.
import timeline from "./timeline.json";

export type P = [number, number] | null; // screen point in 1920x1080 design px, or null if off screen
export interface Anchors {
  head: P; // top of the character's head (thought bubbles float above/right of it)
  pcScreen: P; // centre of the PC monitor across the room (Accept dialog + progress appear here)
}

const W = 1920;
const H = 1080;
const LW = 960; // pixel layer is drawn at half resolution, then upscaled with smoothing off
const LH = 540;
const INK = "#1d1b18";
const PAPER = "#fbfaf6";
const MARI = "#e8a317";
const MARI2 = "#f2b53a";
const VERM = "#c73a2c";
const VERM2 = "#e5594b";
const GREEN = "#3fae6b";
const SKY = "#bfe3f0";
const MUTED = "#5f5a51";
const GREY = "#c9c4b7";
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", "Sukhumvit Set", "Thonburi", sans-serif';

// ---------- math / easing ----------
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const eOut = (u: number) => 1 - (1 - u) ** 3;
const eIn = (u: number) => u * u;
const eInOut = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);
const eBack = (u: number) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2; // easeOutBack, 0 -> 1 with overshoot
/** Pop-in: 0 -> 1.1 -> 1 over 0.25 s. 0 before t0. */
const pop = (t: number, t0: number) => {
  const u = clamp((t - t0) / 0.25);
  if (u <= 0) return 0;
  return u < 0.6 ? 1.1 * eOut(u / 0.6) : 1.1 - 0.1 * eInOut((u - 0.6) / 0.4);
};
/** Exit fade over the 0.2 s before `end`. */
const fadeOut = (t: number, end: number) => clamp((end - t) / 0.2);

// ---------- pixel drawing on the low-res layer ----------
let g: CanvasRenderingContext2D; // the low-res context for the current frame
let low: HTMLCanvasElement | null = null;

const rect = (x: number, y: number, w: number, h: number, col: string) => {
  g.fillStyle = col;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};
/** Rounded pixel box: b-px outline, corners stepped (no anti-aliased curves). */
function box(x: number, y: number, w: number, h: number, fill = PAPER, line = INK, b = 2) {
  rect(x + b, y, w - 2 * b, h, line);
  rect(x, y + b, w, h - 2 * b, line);
  rect(x + 2 * b, y + b, w - 4 * b, h - 2 * b, fill);
  rect(x + b, y + 2 * b, w - 2 * b, h - 4 * b, fill);
}
function disc(cx: number, cy: number, r: number, col: string) {
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.floor(Math.sqrt(r * r + r - dy * dy));
    rect(cx - hw, cy + dy, 2 * hw + 1, 1, col);
  }
}
const font = (px: number, bold: boolean) => `${bold ? 700 : 400} ${px}px ${FONT}`;
function txt(s: string, x: number, y: number, px: number, col: string, bold = false, al: CanvasTextAlign = "left") {
  g.font = font(px, bold);
  g.fillStyle = col;
  g.textAlign = al;
  g.textBaseline = "alphabetic";
  g.fillText(s, Math.round(x), Math.round(y));
}
function tw(s: string, px: number, bold = false) {
  g.font = font(px, bold);
  return g.measureText(s).width;
}
/** Largest integer font size <= px that fits maxW (min 8). */
function fit(s: string, px: number, maxW: number, bold = false) {
  while (px > 8 && tw(s, px, bold) > maxW) px--;
  return px;
}
/** Scale the next drawing by s around (cx, cy). */
function about(cx: number, cy: number, s: number) {
  g.translate(cx, cy);
  g.scale(s, s);
  g.translate(-cx, -cy);
}
function wrap(s: string, px: number, maxW: number, bold: boolean) {
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && tw(next, px, bold) > maxW) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- thought bubbles ----------
type Thought = (typeof timeline.thoughts)[number];
const ICON = 36; // icon slot width in the bubble

function iconUsb(ox: number, oy: number) {
  rect(ox, oy + 10, 13, 12, INK);
  rect(ox + 2, oy + 12, 9, 8, GREY);
  rect(ox + 4, oy + 15, 2, 2, INK);
  rect(ox + 8, oy + 15, 2, 2, INK);
  box(ox + 12, oy + 6, 19, 20, MARI);
  rect(ox + 16, oy + 10, 11, 3, MARI2);
  rect(ox + 24, oy + 17, 4, 4, INK);
}
function iconCloud(ox: number, oy: number, frac: number) {
  for (const [grow, col] of [[2, INK], [0, SKY]] as const) {
    disc(ox + 9, oy + 14, 6 + grow, col);
    disc(ox + 17, oy + 9, 7 + grow, col);
    disc(ox + 24, oy + 15, 5 + grow, col);
    rect(ox + 9 - grow, oy + 14, 15 + 2 * grow, 6 + grow, col);
  }
  box(ox, oy + 25, 32, 7, PAPER, INK, 2); // the slow progress bar
  rect(ox + 2, oy + 27, Math.max(1, 28 * frac), 3, MARI);
}
function iconMail(ox: number, oy: number) {
  box(ox, oy + 6, 30, 22, PAPER);
  for (let i = 0; i <= 12; i++) {
    const y = oy + 9 + Math.round(i * 0.75);
    rect(ox + 3 + i, y, 2, 2, INK);
    rect(ox + 25 - i, y, 2, 2, INK);
  }
  disc(ox + 27, oy + 7, 7, INK); // "too big" badge
  disc(ox + 27, oy + 7, 5, VERM);
  rect(ox + 26, oy + 3, 2, 5, PAPER);
  rect(ox + 26, oy + 9, 2, 2, PAPER);
}
function scribble(ox: number, oy: number, u: number) {
  const strokes: [number, number, number, number, number][] = [
    [ox - 3, oy - 3, ox + 35, oy + 35, clamp(u * 2)],
    [ox + 35, oy - 3, ox - 3, oy + 35, clamp(u * 2 - 1)],
  ];
  for (const [size, col] of [[6, INK], [4, VERM], [2, VERM2]] as const) {
    for (const [x0, y0, x1, y1, p] of strokes) {
      const n = Math.ceil(p * 28);
      for (let i = 0; i <= n; i++) {
        const k = (i / 28);
        rect(lerp(x0, x1, k) - size / 2, lerp(y0, y1, k) - size / 2, size, size, col);
      }
    }
  }
}

function thought(th: Thought, head: [number, number], t: number) {
  if (t < th.t || t >= th.until) return;
  const hx = head[0] / 2;
  const hy = head[1] / 2;
  const px = 13;
  const bh = 48;
  const bw = 8 + ICON + 6 + Math.ceil(tw(th.text, px, true)) + 10;
  const bx = Math.round(Math.min(hx + 26, LW - bw - 8));
  const by = Math.round(Math.max(8, hy - 34 - bh));
  const nopeT = th.t + 1; // the matching "nope" cue
  const wu = clamp((t - nopeT) / 0.35);
  const dx = wu > 0 && wu < 1 ? Math.round(Math.sin(wu * Math.PI * 4) * 3 * (1 - wu)) : 0; // one wobble
  const s = pop(t, th.t);
  if (s <= 0.01) return;
  g.save();
  g.globalAlpha = fadeOut(t, th.until);
  about(hx, hy - 8, s);
  g.translate(dx, 0);
  // three shrinking dots trailing down-left to the head
  const ax = bx + 6;
  const ay = by + bh + 4;
  [[0.1, 5], [0.5, 4], [0.9, 3]].forEach(([f, r]) => {
    const cx = Math.round(lerp(ax, hx + 2, f));
    const cy = Math.round(lerp(ay, hy - 6, f));
    disc(cx, cy, r, INK);
    disc(cx, cy, r - 2, PAPER);
  });
  box(bx, by, bw, bh);
  const ox = bx + 8;
  const oy = by + 8;
  if (th.icon === "usb") iconUsb(ox, oy);
  else if (th.icon === "cloud") iconCloud(ox, oy, 0.06 + 0.22 * clamp((t - th.t) / (th.until - th.t)));
  else iconMail(ox, oy);
  txt(th.text, ox + ICON + 6, by + bh / 2 + 5, px, INK, true);
  const xu = clamp((t - nopeT) / 0.3);
  if (xu > 0) scribble(ox, oy, xu);
  g.restore();
}

// ---------- chat notifications ----------
const CHAT_OUT = 19.5;
const CARD_W = 280;
const CARD_H = 50;
const friends = timeline.chat.filter((m) => m.from === "friend");
const mine = timeline.chat.filter((m) => m.from === "me");

function chatCard(name: string, text: string, x: number, y: number) {
  rect(x + 2, y + 3, CARD_W, CARD_H, "rgba(29,27,24,0.22)"); // hard drop shadow
  box(x, y, CARD_W, CARD_H);
  const ix = x + 9;
  const iy = y + 11;
  box(ix, iy, 28, 28, MARI); // app icon with a blocky chat glyph
  rect(ix + 5, iy + 6, 18, 12, PAPER);
  rect(ix + 7, iy + 18, 4, 3, PAPER);
  rect(ix + 7, iy + 21, 2, 2, PAPER);
  for (let i = 0; i < 3; i++) rect(ix + 9 + i * 4, iy + 11, 2, 2, INK);
  txt("now", x + CARD_W - 10, y + 19, 10, MUTED, false, "right");
  txt(name, x + 46, y + 21, 12, INK, true);
  const maxW = CARD_W - 46 - 12;
  txt(text, x + 46, y + 38, fit(text, 12, maxW), MUTED);
}
function chat(t: number) {
  friends.forEach((m, i) => {
    const inU = clamp((t - m.t) / 0.45);
    const outU = clamp((t - CHAT_OUT - i * 0.08) / 0.4);
    if (inU <= 0 || outU >= 1) return;
    const ty = 12 + i * 56;
    const y = lerp(-CARD_H - 10, ty, eBack(inU)) - eIn(outU) * (ty + CARD_H + 20);
    chatCard(m.name, m.text, (LW - CARD_W) / 2, y);
  });
  for (const m of mine) {
    const end = 77;
    const u = clamp((t - m.t) / 0.4);
    if (u <= 0 || t >= end) continue;
    g.save();
    g.globalAlpha = Math.min(clamp(u * 3), clamp((end - t) / 0.25));
    const px = 14;
    const w = Math.ceil(tw(m.text, px, true)) + 26;
    const h = 34;
    const x = 920 - w;
    const y = 338 + (1 - eBack(u)) * 60; // bottom edge stays above the caption band (y 390 in low-res)
    rect(x + 2, y + 3, w, h, "rgba(29,27,24,0.22)");
    box(x, y, w, h, MARI, INK, 2);
    rect(x + w - 10, y + h, 8, 2, INK); // tail
    rect(x + w - 8, y + h - 2, 6, 2, MARI);
    rect(x + w - 6, y + h + 2, 4, 2, INK);
    txt(m.text, x + 13, y + 22, px, INK, true);
    g.restore();
  }
}

// ---------- Accept dialog on the PC ----------
const cue = (kind: string, d: number, after = 0) => timeline.cues.find((c) => c.kind === kind && c.t > after)?.t ?? d;
const T_DLG = cue("dialog", 68.5);
const T_CLK = cue("click", 70);
const T_IN = T_DLG + 0.4; // cursor enters
const T_ARR = T_CLK - 0.2; // cursor on Accept
const T_PROG = T_CLK + 0.3; // progress card starts filling
const T_DONE = cue("check", 73, T_CLK); // file arrives
const T_GONE = T_DONE + 3.5; // fully faded
const DW = 220;
const DH = 112;

const CURSOR = [
  "X..........", "XX.........", "XPX........", "XPPX.......", "XPPPX......", "XPPPPX.....", "XPPPPPX....", "XPPPPPPX...",
  "XPPPPPPPX..", "XPPPPPPPPX.", "XPPPPPXXXXX", "XPPXPPX....", "XPX.XPPX...", "XX..XPPX...", "X....XPPX..", ".....XXX...",
];
function cursor(x: number, y: number) {
  CURSOR.forEach((row, j) =>
    [...row].forEach((c, i) => {
      if (c !== ".") rect(x + i, y + j, 1, 1, c === "X" ? INK : PAPER);
    }),
  );
}

function pcDialog(t: number, pc: [number, number]) {
  if (t < T_DLG || t >= T_GONE) return;
  const dx = Math.round(clamp(pc[0] / 2 - DW / 2, 4, LW - DW - 4));
  const dy = Math.round(Math.max(4, pc[1] / 2 - DH / 2));
  const bw = 96;
  const bh = 20;
  const ax = dx + DW - 10 - bw; // Accept button
  const ay = dy + DH - 28;
  const press = t >= T_CLK && t < T_CLK + 0.12 ? 1 : 0;
  g.save();
  g.globalAlpha = clamp((T_GONE - t) / 0.5);
  about(dx + DW / 2, dy + DH / 2, pop(t, T_DLG));
  rect(dx + 2, dy + 3, DW, DH, "rgba(29,27,24,0.22)");
  box(dx, dy, DW, DH);
  g.save();
  const phase = t < T_PROG ? T_DLG : t < T_DONE ? T_PROG : T_DONE;
  if (phase !== T_DLG) g.globalAlpha *= clamp((t - phase) / 0.12);
  if (phase === T_DLG) {
    rect(dx + 10, dy + 10, 8, 8, MARI); // tiny app glyph
    wrap("MacBook ของฉัน wants to send you a file", 11, DW - 40, true).forEach((l, i) => txt(l, dx + 24, dy + 18 + i * 13, 11, INK, true));
    box(dx + 10, dy + 44, DW - 20, 26, SKY, INK, 1);
    box(dx + 15, dy + 48, 14, 18, MARI, INK, 1);
    txt("trip.mp4 · 4 GB", dx + 36, dy + 61, 11, INK, true);
    box(dx + 10, dy + DH - 28, bw, bh, PAPER, INK, 2);
    txt("Decline", dx + 10 + bw / 2, dy + DH - 14, 11, INK, true, "center");
    rect(ax + 2, ay + 2, bw, bh, INK);
    box(ax, ay + press * 2, bw, bh, press ? "#2f8f56" : GREEN, INK, 2);
    txt("Accept", ax + bw / 2, ay + 14 + press * 2, 11, PAPER, true, "center");
  } else if (phase === T_PROG) {
    const f = clamp((t - T_PROG) / (T_DONE - T_PROG));
    txt("Receiving trip.mp4", dx + 10, dy + 25, 12, INK, true);
    txt("from MacBook ของฉัน", dx + 10, dy + 40, 10, MUTED);
    box(dx + 10, dy + 50, DW - 20, 18, PAPER, INK, 2);
    const inner = DW - 20 - 6;
    rect(dx + 13, dy + 53, inner * f, 12, MARI);
    for (let x = 6; x < inner * f; x += 6) rect(dx + 13 + x, dy + 53, 2, 12, MARI2); // chunk ticks
    txt(`${Math.round(f * 100)}%`, dx + 10, dy + 92, 12, INK, true);
    txt(`${(4 * f).toFixed(1)} / 4 GB`, dx + DW - 10, dy + 92, 11, MUTED, false, "right");
  } else {
    const cx = dx + 30;
    const cy = dy + DH / 2;
    g.save();
    about(cx, cy, pop(t, T_DONE));
    disc(cx, cy, 15, INK);
    disc(cx, cy, 13, GREEN);
    [[-7, 0], [-5, 2], [-3, 4], [-1, 2], [1, 0], [3, -2], [5, -4], [7, -6]].forEach(([a, b]) => rect(cx + a - 1, cy + b - 1, 3, 3, PAPER));
    g.restore();
    txt("Saved to Downloads/Yon", dx + 54, dy + DH / 2 - 2, fit("Saved to Downloads/Yon", 12, DW - 64, true), INK, true);
    txt("trip.mp4 · 4 GB · verified", dx + 54, dy + DH / 2 + 14, 10, MUTED);
  }
  g.restore();
  g.restore();

  // mouse cursor: enters from the lower right, eases onto Accept, clicks, drifts away
  if (t < T_IN) return;
  const tipX = ax + bw / 2 - 6;
  const tipY = ay + bh / 2 - 4;
  const u = eInOut(clamp((t - T_IN) / (T_ARR - T_IN)));
  const away = clamp((t - T_PROG - 0.1) / 0.5);
  const cx = lerp(tipX + 200, tipX, u) + eIn(away) * 60;
  const cy = lerp(tipY + 160, tipY, u) + eIn(away) * 50 + press;
  if (away >= 1) return;
  g.save();
  g.globalAlpha = Math.min(clamp((t - T_IN) / 0.15), 1 - away);
  cursor(Math.round(cx), Math.round(cy));
  const ck = clamp((t - T_CLK) / 0.3);
  if (ck > 0 && ck < 1) {
    const r = 4 + Math.round(ck * 8);
    for (const [a, b] of [[-r, -r], [r, -r], [-r, r], [r, r]]) rect(cx + a, cy + b, 2, 2, MARI); // click burst
  }
  g.restore();
}

// ---------- captions (full res) ----------
function captions(ctx: CanvasRenderingContext2D, t: number, gf: number) {
  const s = timeline.scenes.find((sc) => t >= sc.start && t < sc.end);
  if (!s || !s.caption) return;
  const inA = clamp((t - s.start - 0.6) / 0.8);
  const a = Math.min(inA, clamp((s.end - t) / 0.6)) * gf;
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  const band = ctx.createLinearGradient(0, H - 300, 0, H);
  band.addColorStop(0, "rgba(12,13,17,0)");
  band.addColorStop(0.45, "rgba(12,13,17,0.7)");
  band.addColorStop(1, "rgba(12,13,17,0.85)");
  ctx.fillStyle = band;
  ctx.fillRect(0, H - 300, W, 300);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const rise = (1 - inA) * 12;
  ctx.fillStyle = "#eceef2";
  ctx.font = font(64, true);
  ctx.fillText(s.caption, W / 2, H - 150 + rise);
  ctx.fillStyle = "#b9bfcc";
  ctx.font = font(30, false);
  ctx.fillText(s.sub, W / 2, H - 94 + rise);
  ctx.restore();
}

// ---------- entry ----------
/** Draw the whole overlay for time t. ctx canvas is W*scale x H*scale. Clears it first. */
export function drawOverlay(ctx: CanvasRenderingContext2D, t: number, scale: number, anchors: Anchors): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const gf = clamp(Math.min(t / 0.8, (timeline.duration - t) / 2));
  if (gf <= 0) return;

  if (!low) {
    low = document.createElement("canvas");
    low.width = LW;
    low.height = LH;
  }
  g = low.getContext("2d") as CanvasRenderingContext2D;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.clearRect(0, 0, LW, LH);
  g.imageSmoothingEnabled = false;
  if (anchors.head) for (const th of timeline.thoughts) thought(th, anchors.head, t);
  if (anchors.pcScreen) pcDialog(t, anchors.pcScreen);
  chat(t);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = gf;
  ctx.drawImage(low, 0, 0, LW, LH, 0, 0, W * scale, H * scale);
  ctx.restore();

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  captions(ctx, t, gf);
  ctx.restore();
}
