// Shared drawing kit for the editorial reel. Every scene draws in a fixed
// 1920x1080 space (film.ts scales the context), and every function here is a
// pure function of its arguments, so any frame renders the same every time.
//
// Fonts are system stacks on purpose: this origin serves no font files and the
// CSP allows none from elsewhere. system-ui 900 is SF Pro Black on a Mac and
// Segoe UI Black on Windows; the serif and mono fall back the same way.
import timeline from "./timeline.json";

export const W = 1920;
export const H = 1080;
export const BAR = 60 / timeline.bpm * 4; // 2.667 s
export const BEAT = BAR / 4;

export type Ctx = CanvasRenderingContext2D;
/** Draws one scene. `t` is seconds since the scene began, `T` the film time. */
export type Scene = (ctx: Ctx, t: number, T: number) => void;

export const C = {
  paper: "#F3F1EC",
  marigoldSoft: "#F8D98A",
  peach: "#F6C9B0",
  sky: "#BFE3F0",
  marigold: "#E8A317",
  vermilion: "#C73A2C",
  green: "#3FAE6B",
  ink: "#131419",
  inkText: "#ECE8DF",
  muted: "#77736B",
  line: "#D9D5CC",
  white: "#FFFFFF",
  blueprint: "#6FA8C8",
};

export const F = {
  grotesk: (px: number, w = 900) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif`,
  serif: (px: number) => `italic 400 ${px}px "Iowan Old Style", "Palatino", Georgia, "Times New Roman", serif`,
  mono: (px: number, w = 500) => `${w} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
  thai: (px: number, w = 600) => `${w} ${px}px "IBM Plex Sans Thai", Thonburi, "Leelawadee UI", "Noto Sans Thai", system-ui, sans-serif`,
};

// ---------- time ----------
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** 0 before a, 1 after b, linear between. */
export const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const easeOut = (u: number) => 1 - (1 - u) ** 3;
export const easeIn = (u: number) => u ** 3;
export const easeInOut = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);
export const easeOutExpo = (u: number) => (u >= 1 ? 1 : 1 - 2 ** (-10 * u));
export const easeOutBack = (u: number, s = 1.7) => 1 + (s + 1) * (u - 1) ** 3 + s * (u - 1) ** 2;
/** A hit that decays after time `at`: 1 at the hit, ~0 after `len` seconds. */
export const hit = (t: number, at: number, len = 0.35) => (t < at ? 0 : Math.exp((-(t - at) / len) * 4));

/** Seeded PRNG (mulberry32): same seed, same sequence. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- backgrounds ----------
/** Washi paper with slow, blurred marigold / peach / sky light. */
export function paperBg(ctx: Ctx, T: number, strength = 1) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  const blobs: [string, number, number, number][] = [
    [C.marigoldSoft, 0.22, 0.28, 0],
    [C.peach, 0.78, 0.7, 2.1],
    [C.sky, 0.66, 0.18, 4.2],
  ];
  ctx.save();
  ctx.globalAlpha = 0.85 * strength;
  for (const [col, bx, by, ph] of blobs) {
    const x = (bx + 0.06 * Math.sin(T * 0.13 + ph)) * W;
    const y = (by + 0.06 * Math.cos(T * 0.11 + ph)) * H;
    const r = 720;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col);
    g.addColorStop(1, "rgba(243,241,236,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

export function darkBg(ctx: Ctx) {
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
}

// ---------- blur / depth ----------
/** Runs `draw` with a CSS blur (depth of field). 0 = sharp. */
export function blurred(ctx: Ctx, px: number, draw: () => void) {
  ctx.save();
  if (px > 0.3) ctx.filter = `blur(${px.toFixed(1)}px)`;
  draw();
  ctx.restore();
}

// ---------- type ----------
export interface Run {
  text: string;
  /** serif italic instead of the heavy grotesk */
  italic?: boolean;
  color?: string;
}

/**
 * One headline line mixing heavy grotesk and serif italic runs, e.g.
 * [{ text: "Finds what's " }, { text: "nearby.", italic: true }].
 * `reveal` 0..1 slides each run up and fades it in, one after another.
 */
export function headline(ctx: Ctx, runs: Run[], x: number, y: number, size: number, opts: { align?: "left" | "center"; color?: string; reveal?: number } = {}) {
  const color = opts.color ?? C.ink;
  const reveal = opts.reveal ?? 1;
  const fontOf = (r: Run) => (r.italic ? F.serif(size * 1.08) : F.grotesk(size));
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const widths = runs.map((r) => {
    ctx.font = fontOf(r);
    return ctx.measureText(r.text).width;
  });
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = opts.align === "center" ? x - total / 2 : x;
  runs.forEach((r, i) => {
    const u = easeOut(clamp(reveal * runs.length - i));
    ctx.font = fontOf(r);
    ctx.globalAlpha = u;
    ctx.fillStyle = r.color ?? color;
    ctx.fillText(r.text, cx, y + (1 - u) * size * 0.5);
    cx += widths[i];
  });
  ctx.restore();
  return total;
}

export function mono(ctx: Ctx, text: string, x: number, y: number, size = 22, color: string = C.muted, align: CanvasTextAlign = "left") {
  ctx.save();
  ctx.font = F.mono(size);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function thai(ctx: Ctx, text: string, x: number, y: number, size = 40, color: string = C.ink, align: CanvasTextAlign = "left", weight = 600) {
  ctx.save();
  ctx.font = F.thai(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Types `text` out: the first `u` (0..1) of its characters, plus a caret. */
export function typed(text: string, u: number, caret = true) {
  const n = Math.floor(clamp(u) * text.length);
  return text.slice(0, n) + (caret && u > 0 && u < 1 ? "▍" : "");
}

// ---------- shapes ----------
export function card(ctx: Ctx, x: number, y: number, w: number, h: number, opts: { fill?: string; r?: number; shadow?: number; stroke?: string } = {}) {
  ctx.save();
  if (opts.shadow) {
    ctx.shadowColor = "rgba(19,20,25,0.16)";
    ctx.shadowBlur = opts.shadow;
    ctx.shadowOffsetY = opts.shadow * 0.35;
  }
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, opts.r ?? 18);
  ctx.fillStyle = opts.fill ?? C.white;
  ctx.fill();
  if (opts.stroke) {
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The brand motif: a small file card (dog-eared page + name + size), centred
 * at (cx, cy), 220x140 at scale 1.
 */
export function fileCard(ctx: Ctx, cx: number, cy: number, scale = 1, rot = 0, name = "trip.mp4", size = "4 GB", accent: string = C.marigold) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  card(ctx, -110, -70, 220, 140, { r: 16, shadow: 24 });
  // page icon
  ctx.beginPath();
  ctx.moveTo(-86, -46);
  ctx.lineTo(-58, -46);
  ctx.lineTo(-46, -34);
  ctx.lineTo(-46, 0);
  ctx.lineTo(-86, 0);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.font = F.grotesk(24, 800);
  ctx.fillStyle = C.ink;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, -86, 36);
  ctx.font = F.mono(16);
  ctx.fillStyle = C.muted;
  ctx.fillText(size, -86, 58);
  ctx.restore();
}

/** Point on the toss arc from (x0,y0) to (x1,y1) peaking `lift` px above. */
export function arcPoint(x0: number, y0: number, x1: number, y1: number, lift: number, u: number): [number, number] {
  return [lerp(x0, x1, u), lerp(y0, y1, u) - lift * 4 * u * (1 - u)];
}

/** The dashed toss arc, drawn up to `u` (0..1). */
export function dashedArc(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, lift: number, u: number, color: string = C.ink, width = 3) {
  ctx.save();
  ctx.setLineDash([14, 12]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  const n = Math.max(2, Math.floor(60 * u));
  for (let i = 0; i <= n; i++) {
    const [x, y] = arcPoint(x0, y0, x1, y1, lift, (u * i) / n);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** A check mark in a circle, drawn in by `u`. */
export function check(ctx: Ctx, x: number, y: number, r: number, u: number, color: string = C.green) {
  if (u <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r * easeOutBack(clamp(u * 2)), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  const v = clamp(u * 2 - 1);
  ctx.strokeStyle = C.white;
  ctx.lineWidth = r * 0.18;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const pts: [number, number][] = [[-0.42, 0.02], [-0.12, 0.3], [0.44, -0.3]];
  ctx.moveTo(x + pts[0][0] * r, y + pts[0][1] * r);
  if (v > 0) {
    const a = clamp(v * 2);
    ctx.lineTo(x + lerp(pts[0][0], pts[1][0], a) * r, y + lerp(pts[0][1], pts[1][1], a) * r);
    if (v > 0.5) {
      const b = clamp(v * 2 - 1);
      ctx.lineTo(x + lerp(pts[1][0], pts[2][0], b) * r, y + lerp(pts[1][1], pts[2][1], b) * r);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** A vermilion cross, the two strokes drawn in by `u`. */
export function cross(ctx: Ctx, x: number, y: number, r: number, u: number, color: string = C.vermilion) {
  if (u <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.22;
  ctx.lineCap = "round";
  const a = clamp(u * 2);
  const b = clamp(u * 2 - 1);
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x - r + 2 * r * a, y - r + 2 * r * a);
  if (b > 0) {
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x + r - 2 * r * b, y - r + 2 * r * b);
  }
  ctx.stroke();
  ctx.restore();
}

/** A full-screen marigold card with a big line and a mono line under a rule. */
export function bigCard(ctx: Ctx, t: number, big: Run[], small: string, opts: { fill?: string } = {}) {
  ctx.fillStyle = opts.fill ?? C.marigold;
  ctx.fillRect(0, 0, W, H);
  const u = easeOutExpo(prog(t, 0, 0.5));
  headline(ctx, big, 160, 600 + (1 - u) * 80, 190, { reveal: u, color: C.ink });
  ctx.fillStyle = C.ink;
  ctx.fillRect(160, 690, 1600 * easeOut(prog(t, 0.2, 0.9)), 3);
  ctx.globalAlpha = prog(t, 0.4, 0.8);
  mono(ctx, small, 160, 750, 30, C.ink);
  ctx.globalAlpha = 1;
}
