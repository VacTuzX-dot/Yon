// Scenes 0-48 s of the editorial reel: cold, title, tagline, problem, nudge,
// nearby, platforms, sealed, nocloud. Every scene is a pure function of time;
// visual events land on the cue times in timeline.json (film time `T`).
import {
  C, F, H, W, arcPoint, blurred, card, check, clamp, cross, darkBg, dashedArc, easeInOut, easeOut,
  easeOutBack, easeOutExpo, fileCard, headline, hit, lerp, mono, paperBg, prog, rng, thai,
  type Ctx, type Scene,
} from "./kit";

const TAU = Math.PI * 2;
const ex = (T: number, a: number, b: number) => easeOutExpo(prog(T, a, b));
const pop = (T: number, a: number, d = 0.45, s = 1.8) => easeOutBack(prog(T, a, a + d), s);
const fmt = (n: number) => String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const spacing = (ctx: Ctx, v: string) => {
  (ctx as unknown as { letterSpacing: string }).letterSpacing = v;
};

/** Slow camera drift: scale z0->z1 and pan (dx,dy) over `dur` seconds, about the centre. */
function cam(ctx: Ctx, t: number, dur: number, z0: number, z1: number, dx = 0, dy = 0) {
  const u = clamp(t / dur);
  const z = lerp(z0, z1, u);
  ctx.translate(W / 2 + dx * u, H / 2 + dy * u);
  ctx.scale(z, z);
  ctx.translate(-W / 2, -H / 2);
}

function star4(ctx: Ctx, x: number, y: number, r: number, col: string, a = 1, rot = 0) {
  if (r <= 0.3 || a <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.globalAlpha = a;
  ctx.fillStyle = col;
  const k = r * 0.14;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(k, -k, r, 0);
  ctx.quadraticCurveTo(k, k, 0, r);
  ctx.quadraticCurveTo(-k, k, -r, 0);
  ctx.quadraticCurveTo(-k, -k, 0, -r);
  ctx.fill();
  ctx.restore();
}

/** A cheap file card (no shadow) for crowds. */
function mini(ctx: Ctx, x: number, y: number, s: number, rot: number, face: string, a: number) {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.roundRect(-55, -35, 110, 70, 8);
  ctx.fill();
  ctx.fillStyle = C.marigold;
  ctx.fillRect(-43, -23, 18, 22);
  ctx.fillStyle = "rgba(19,20,25,0.55)";
  ctx.fillRect(-43, 10, 62, 7);
  ctx.fillStyle = "rgba(19,20,25,0.28)";
  ctx.fillRect(-43, 22, 36, 5);
  ctx.restore();
}

// =====================================================================
// 0. COLD OPEN (0-8): chaos of cards, then one stream
// =====================================================================
interface ColdCard {
  bx: number; by: number; d: number; ph: number; fx: number; fy: number; ax: number; ay: number;
  rot0: number; spin: number; lane: number; face: string; vx: number; band: number;
}
const COLD_FACES = ["#F3F1EC", C.marigoldSoft, C.peach, C.sky, "#F3F1EC"];
const COLD_BLUR = [9, 3.5, 0, 16];
const coldCards: ColdCard[] = (() => {
  const r = rng(11);
  const arr: ColdCard[] = [];
  for (let i = 0; i < 230; i++) {
    const d = r() ** 0.9;
    arr.push({
      bx: r() * W, by: r() * H, d, ph: r() * TAU, fx: 0.5 + r() * 1.3, fy: 0.4 + r() * 1.1,
      ax: 90 + r() * 280, ay: 70 + r() * 220, rot0: r() * TAU, spin: (r() - 0.5) * 5,
      lane: Math.floor(r() * 14), face: COLD_FACES[Math.floor(r() * COLD_FACES.length)],
      vx: 380 + d * 1300, band: d < 0.45 ? 0 : d < 0.78 ? 1 : d < 0.94 ? 2 : 3,
    });
  }
  return arr.sort((a, b) => a.d - b.d);
})();

const layerCache: Record<number, CanvasRenderingContext2D> = {};
function layerCtx(key: number): CanvasRenderingContext2D {
  let l = layerCache[key];
  if (!l) {
    const c = document.createElement("canvas");
    c.width = W / 2;
    c.height = H / 2;
    l = layerCache[key] = c.getContext("2d")!;
  }
  return l;
}

const cold: Scene = (ctx, t, T) => {
  const A = 5.3333;
  darkBg(ctx);
  const g = (prog(T, 0.3, 2.9) ** 2) * 0.92 + 0.03 * prog(T, 0, 1);
  const ampAt = (x: number) => 0.2 + 0.8 * easeOut(prog(x, 2.667, 3.6));
  const snap = ex(T, A, A + 0.35);
  const dt = Math.max(0, T - A);
  const Tc = Math.min(T, A);
  const amp = ampAt(Tc);
  const wrap = (x: number) => ((((x + 300) % (W + 600)) + (W + 600)) % (W + 600)) - 300;
  ctx.save();
  cam(ctx, t, 8, 1, 1.07, -40, 0);
  // WHY: blurring ~200 cards one by one is slow; each blurred depth band is drawn
  // sharp into a half-res layer and blurred once when composited.
  const layers = [0, 1, 2, 3].map((b) => (COLD_BLUR[b] > 0.3 ? layerCtx(b) : null));
  layers.forEach((l) => l && (l.setTransform(0.5, 0, 0, 0.5, 0, 0), l.clearRect(0, 0, W, H)));
  const drawCard = (c: ColdCard, dst: Ctx) => {
    const x0 = c.bx + c.ax * amp * Math.sin(Tc * c.fx + c.ph) + (c.d - 0.5) * 60 * Tc;
    const y0 = c.by + c.ay * amp * Math.cos(Tc * c.fy + c.ph * 1.3) + 40 * amp * Math.sin(Tc * c.fx * 2.3 + c.ph);
    const rc = c.rot0 + 0.9 * Math.sin(Tc * c.fx * 1.7 + c.ph) + c.spin * Tc * amp * 0.3;
    const rot = (((rc + Math.PI) % TAU) + TAU) % TAU - Math.PI;
    const laneY = 150 + (c.lane / 13) * 790 + (c.d - 0.5) * 26;
    const s = c.band === 3 ? 2.6 : lerp(0.32, 1.3, c.d);
    const flow = c.vx * (dt + 0.35 * (1 - Math.exp(-dt * 5))) * (1 + 0.25 * dt);
    const x = wrap(x0 + flow);
    const y = lerp(y0, laneY, snap);
    const a = g * lerp(0.5, 1, c.d);
    if (snap > 0.25) {
      const len = c.vx * 0.06 * snap * (0.5 + s * 0.5);
      dst.globalAlpha = 1;
      dst.fillStyle = `rgba(243,241,236,${(a * 0.16).toFixed(3)})`;
      dst.fillRect(x - 55 * s - len, y - 5 * s, len, 10 * s);
      dst.fillStyle = `rgba(243,241,236,${(a * 0.12).toFixed(3)})`;
      dst.fillRect(x - 55 * s - len * 0.45, y - 12 * s, len * 0.45, 24 * s);
    }
    mini(dst, x, y, s, rot * (1 - snap), c.face, a);
  };
  // far -> near: blurred bands are composited in depth order around the sharp one
  for (let b = 0; b < 4; b++) {
    const l = layers[b];
    for (const c of coldCards) if (c.band === b) drawCard(c, l ?? ctx);
    if (!l) continue;
    ctx.save();
    ctx.filter = `blur(${COLD_BLUR[b]}px)`;
    ctx.drawImage(l.canvas, 0, 0, W, H);
    ctx.restore();
  }
  ctx.restore();

  // marigold glow at the right edge, where the stream is heading
  const gl = prog(T, A, A + 0.8);
  if (gl > 0) {
    const gr = ctx.createRadialGradient(W, H / 2, 0, W, H / 2, 900);
    gr.addColorStop(0, `rgba(232,163,23,${(0.3 * gl).toFixed(3)})`);
    gr.addColorStop(1, "rgba(232,163,23,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  }
  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 1.0);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  // snap flash line
  const h = hit(T, A, 0.22);
  if (h > 0.02) {
    ctx.fillStyle = `rgba(255,255,255,${(0.5 * h).toFixed(3)})`;
    ctx.fillRect(0, H / 2 - 3 - 30 * (1 - h), W, 6 + 60 * (1 - h));
  }
  // byte counter, bottom right
  if (T >= A) {
    const u = prog(T, A, 7.6);
    const n = 4294967296 * u ** 1.6;
    const a = prog(T, A, A + 0.25);
    const pl = ctx.createLinearGradient(0, H - 300, 0, H);
    pl.addColorStop(0, "rgba(19,20,25,0)");
    pl.addColorStop(1, `rgba(19,20,25,${(0.85 * a).toFixed(3)})`);
    ctx.fillStyle = pl;
    ctx.fillRect(W - 900, H - 300, 900, 300);
    ctx.save();
    ctx.globalAlpha = a;
    mono(ctx, "FILE NUMBER: 0 → 4,294,967,296 BYTES (4 GB)", W - 100, H - 215, 24, "rgba(236,232,223,0.6)", "right");
    ctx.font = F.mono(62, 700);
    ctx.textAlign = "right";
    ctx.fillStyle = C.inkText;
    ctx.fillText(fmt(n), W - 100, H - 145);
    ctx.fillStyle = C.marigold;
    ctx.fillRect(W - 100 - 620 * u, H - 128, 620 * u, 4);
    ctx.restore();
  }
};

// =====================================================================
// 1. TITLE (8-13.33)
// =====================================================================
const titleDrift = (() => {
  const r = rng(23);
  return Array.from({ length: 9 }, () => ({ x: r() * W, y: r() * H, s: 0.8 + r() * 1.4, rot: (r() - 0.5) * 0.8, v: 14 + r() * 26, ph: r() * TAU }));
})();
const sparkles = (() => {
  const r = rng(5);
  return Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * TAU + r() * 0.4;
    const rx = 560 + r() * 240;
    return { x: 960 + Math.cos(a) * rx, y: 600 + Math.sin(a) * (rx * 0.42), r: 16 + r() * 22, off: i * 0.13, per: 0.9 + r() * 0.6 };
  });
})();

const title: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  // depth: drifting blurred cards, drawn into a half-res layer and blurred once
  // (a blur filter on each card's shadowed draw ran the title at ~40 fps)
  const dl = layerCtx(30);
  dl.setTransform(0.5, 0, 0, 0.5, 0, 0);
  dl.clearRect(0, 0, W, H);
  for (const c of titleDrift) {
    const x = ((c.x + T * c.v + 200) % (W + 400)) - 200;
    fileCard(dl, x, c.y + Math.sin(T * 0.5 + c.ph) * 20, c.s, c.rot + Math.sin(T * 0.4 + c.ph) * 0.1);
  }
  blurred(ctx, 11, () => ctx.drawImage(dl.canvas, 0, 0, W, H));
  ctx.save();
  cam(ctx, t, 5.33, 1, 1.07, 0, -8);
  const h = hit(T, 8, 0.4);
  const u = prog(T, 8, 8.6);
  const s = lerp(2.6, 1, easeOutBack(u, 2.2));
  const shake = Math.sin(T * 70) * 10 * h;
  // impact ring
  const ru = prog(T, 8, 9.0);
  if (ru > 0 && ru < 1) {
    ctx.strokeStyle = `rgba(19,20,25,${(0.35 * (1 - ru)).toFixed(3)})`;
    ctx.lineWidth = 6 * (1 - ru) + 1;
    ctx.beginPath();
    ctx.ellipse(960, 610, 200 + easeOutExpo(ru) * 1100, 90 + easeOutExpo(ru) * 420, 0, 0, TAU);
    ctx.stroke();
  }
  // YON
  ctx.save();
  ctx.translate(960 + shake, 640 + shake * 0.4);
  ctx.scale(s, s);
  ctx.font = F.grotesk(340, 900);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const w = ctx.measureText("YON").width;
  ctx.globalAlpha = prog(T, 8, 8.06);
  ctx.fillStyle = C.ink;
  ctx.fillText("YON", 9, 10);
  const gr = ctx.createLinearGradient(-w / 2, -250, w / 2, 40);
  gr.addColorStop(0, C.marigold);
  gr.addColorStop(0.36, "#F5A77F");
  gr.addColorStop(0.62, "#F2B4BE");
  gr.addColorStop(0.9, "#86CDE8");
  ctx.fillStyle = gr;
  ctx.fillText("YON", 0, 0);
  ctx.restore();
  // Thai
  const tu = ex(T, 8.25, 8.85);
  ctx.save();
  ctx.globalAlpha = tu;
  thai(ctx, "โยน", 960, 360 - (1 - tu) * 40, 120, C.ink, "center", 800);
  ctx.restore();
  // mono
  const mu = prog(T, 8.6, 9.1);
  ctx.save();
  ctx.globalAlpha = mu;
  spacing(ctx, "10px");
  mono(ctx, "OPEN-SOURCE FILE TRANSFER", 960 + 5, 760 + (1 - mu) * 14, 30, C.ink, "center");
  spacing(ctx, "0px");
  ctx.restore();
  // vermilion sparkles
  if (T >= 10.667) {
    const tt = T - 10.667;
    for (const p of sparkles) {
      const ph = (tt - p.off) / p.per;
      if (ph < 0) continue;
      const k = Math.sin(clamp(ph % 1) * Math.PI);
      star4(ctx, p.x, p.y, p.r * k * (0.7 + 0.3 * easeOutBack(clamp(ph))), C.vermilion, 1, ph * 0.6);
    }
  }
  ctx.restore();
};

// =====================================================================
// 2. TAGLINE (13.33-16)
// =====================================================================
const pixelBlocks = (() => {
  const r = rng(31);
  const out: { x: number; y: number; s: number; col: string; d: number }[] = [];
  for (let gx = 0; gx < 10; gx++) for (let gy = 0; gy < 7; gy++) {
    if (r() < 0.35) continue;
    out.push({ x: 90 + gx * 34, y: 720 + gy * 34, s: 28, col: [C.marigold, C.peach, C.marigoldSoft, C.sky][Math.floor(r() * 4)], d: r() });
  }
  return out;
})();

const tagline: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  ctx.save();
  cam(ctx, t, 2.67, 1.0, 1.05, -20, -6);
  const rv = ex(T, 13.36, 14.1);
  headline(ctx, [{ text: "For the computer " }], 150, 330, 150, { reveal: rv });
  headline(ctx, [{ text: "next to you.", italic: true }], 150, 500, 150, { reveal: ex(T, 13.6, 14.3), color: C.ink });
  // marigold underline
  ctx.fillStyle = C.marigold;
  ctx.fillRect(150, 530, 830 * ex(T, 14.3, 14.9), 8);

  const x0 = 290, y0 = 840, x1 = 1640, y1 = 860, lift = 250;
  // landing pad
  ctx.save();
  ctx.setLineDash([10, 10]);
  ctx.strokeStyle = "rgba(19,20,25,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(x1 - 122, y1 - 82, 244, 164, 22);
  ctx.stroke();
  ctx.restore();
  // pixel blocks peel off the card
  for (const b of pixelBlocks) {
    const k = prog(T, 13.333 + b.d * 0.35, 14.2 + b.d * 0.4);
    const a = lerp(0.85, 0.16, easeOut(k));
    ctx.globalAlpha = a;
    ctx.fillStyle = b.col;
    ctx.fillRect(b.x - k * 12 * b.d, b.y + k * 10 * (b.d - 0.5) * 6, b.s, b.s);
  }
  ctx.globalAlpha = 1;
  const u = prog(T, 13.333, 14.9);
  dashedArc(ctx, x0, y0, x1, y1, lift, easeInOut(u), "rgba(19,20,25,0.5)", 3);
  const [ax, ay] = arcPoint(x0, y0, x1, y1, lift, easeInOut(u));
  const land = hit(T, 14.9, 0.3);
  const sq = T >= 14.9 ? Math.sin(land * Math.PI) * 0.0 + land * 0.3 : 0;
  const bob = T >= 14.9 ? Math.sin((T - 14.9) * 3) * 4 * (1 - land) : 0;
  // trail ghosts while flying
  if (u > 0 && u < 1) {
    for (let i = 3; i >= 1; i--) {
      const uu = Math.max(0, easeInOut(u) - i * 0.03);
      const [gx, gy] = arcPoint(x0, y0, x1, y1, lift, uu);
      ctx.globalAlpha = 0.12 * (4 - i);
      fileCard(ctx, gx, gy, 1, lerp(-0.3, 0.12, u));
    }
    ctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.translate(ax, ay + bob + (land * 14));
  ctx.scale(1 + sq * 0.5, 1 - sq);
  fileCard(ctx, 0, 0, 1, u < 1 ? lerp(-0.3, 0.12, u) : lerp(0.12, 0, easeOut(prog(T, 14.9, 15.3))));
  ctx.restore();
  // dust at landing
  if (T >= 14.9) {
    const d = prog(T, 14.9, 15.5);
    ctx.strokeStyle = `rgba(232,163,23,${(0.6 * (1 - d)).toFixed(3)})`;
    ctx.lineWidth = 5 * (1 - d) + 1;
    ctx.beginPath();
    ctx.ellipse(x1, y1 + 78, 120 + 90 * easeOutExpo(d), 14 + 16 * easeOutExpo(d), 0, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI + Math.PI;
      star4(ctx, x1 + Math.cos(a) * (150 + d * 90), y1 + 70 + Math.sin(a) * (40 + d * 80), 14 * (1 - d), C.marigold, 1 - d);
    }
  }
  ctx.restore();
};

// =====================================================================
// 3. PROBLEM (16-21.33): blueprint
// =====================================================================
const BP = "#5E9BBF";
const BP_FILL = "rgba(191,227,240,0.42)";

function bpStroke(ctx: Ctx, w = 3.5) {
  ctx.strokeStyle = BP;
  ctx.lineWidth = w;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
}
/** Reveals a drawing left to right (like ink being laid down). */
function wipe(ctx: Ctx, x: number, y: number, w: number, h: number, u: number, draw: () => void) {
  if (u <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w * clamp(u), h);
  ctx.clip();
  draw();
  ctx.restore();
}
function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill = true) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = BP_FILL;
    ctx.fill();
  }
  ctx.stroke();
}
function drawLaptop(ctx: Ctx, cx: number, cy: number) {
  bpStroke(ctx);
  rr(ctx, cx - 135, cy - 100, 270, 170, 14);
  rr(ctx, cx - 120, cy - 86, 240, 142, 6, false);
  ctx.beginPath();
  ctx.moveTo(cx - 175, cy + 70);
  ctx.lineTo(cx + 175, cy + 70);
  ctx.lineTo(cx + 150, cy + 96);
  ctx.lineTo(cx - 150, cy + 96);
  ctx.closePath();
  ctx.fillStyle = BP_FILL;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy + 78);
  ctx.lineTo(cx + 30, cy + 78);
  ctx.stroke();
  // a file on the screen
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy - 62);
  ctx.lineTo(cx + 6, cy - 62);
  ctx.lineTo(cx + 28, cy - 40);
  ctx.lineTo(cx + 28, cy + 14);
  ctx.lineTo(cx - 28, cy + 14);
  ctx.closePath();
  ctx.stroke();
}
function drawPC(ctx: Ctx, cx: number, cy: number) {
  bpStroke(ctx);
  rr(ctx, cx - 135, cy - 100, 270, 170, 14);
  rr(ctx, cx - 120, cy - 86, 240, 142, 6, false);
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy + 70);
  ctx.lineTo(cx - 40, cy + 100);
  ctx.lineTo(cx + 40, cy + 100);
  ctx.lineTo(cx + 28, cy + 70);
  ctx.stroke();
  rr(ctx, cx - 80, cy + 100, 160, 14, 7);
  // tower
  rr(ctx, cx + 170, cy - 60, 90, 174, 10);
  ctx.beginPath();
  ctx.arc(cx + 215, cy - 30, 8, 0, TAU);
  ctx.moveTo(cx + 190, cy + 40);
  ctx.lineTo(cx + 240, cy + 40);
  ctx.moveTo(cx + 190, cy + 58);
  ctx.lineTo(cx + 240, cy + 58);
  ctx.stroke();
}
function drawUSB(ctx: Ctx, cx: number, cy: number) {
  bpStroke(ctx);
  rr(ctx, cx - 70, cy - 30, 100, 60, 12);
  rr(ctx, cx + 30, cy - 18, 46, 36, 4);
  ctx.beginPath();
  ctx.rect(cx + 42, cy - 9, 8, 7);
  ctx.rect(cx + 58, cy - 9, 8, 7);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - 46, cy, 7, 0, TAU);
  ctx.stroke();
}
function drawCloud(ctx: Ctx, cx: number, cy: number) {
  bpStroke(ctx);
  ctx.beginPath();
  ctx.moveTo(cx - 80, cy + 40);
  ctx.bezierCurveTo(cx - 130, cy + 40, cx - 130, cy - 20, cx - 80, cy - 20);
  ctx.bezierCurveTo(cx - 80, cy - 70, cx - 10, cy - 80, cx + 10, cy - 40);
  ctx.bezierCurveTo(cx + 50, cy - 70, cx + 100, cy - 40, cx + 80, cy - 10);
  ctx.bezierCurveTo(cx + 130, cy - 5, cx + 125, cy + 40, cx + 80, cy + 40);
  ctx.closePath();
  ctx.fillStyle = BP_FILL;
  ctx.fill();
  ctx.stroke();
}
function drawEnvelope(ctx: Ctx, cx: number, cy: number) {
  bpStroke(ctx);
  rr(ctx, cx - 100, cy - 62, 200, 124, 10);
  ctx.beginPath();
  ctx.moveTo(cx - 100, cy - 58);
  ctx.lineTo(cx, cy + 12);
  ctx.lineTo(cx + 100, cy - 58);
  ctx.stroke();
}

const problem: Scene = (ctx, t, T) => {
  paperBg(ctx, T, 0.55);
  ctx.save();
  cam(ctx, t, 5.33, 1.0, 1.04, -24, 6);
  // blueprint grid
  ctx.strokeStyle = "rgba(94,155,191,0.16)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = -120; x <= W + 120; x += 60) {
    ctx.moveTo(x, -80);
    ctx.lineTo(x, H + 80);
  }
  for (let y = -80; y <= H + 80; y += 60) {
    ctx.moveTo(-120, y);
    ctx.lineTo(W + 120, y);
  }
  ctx.stroke();

  const LX = 330, LY = 760, PX = 1490, PY = 760;
  const IT = [650, 960, 1270];
  const IY = 480;
  const crosses = [16.6667, 18.0, 19.3333];
  const enter = [16.15, 17.25, 18.55];

  // headline
  headline(ctx, [{ text: "The PC is " }, { text: "right there.", italic: true }], 150, 290, 112, { reveal: prog(T, 19.83, 20.83) });

  // laptop
  wipe(ctx, LX - 200, LY - 110, 400, 240, ex(T, 16.0, 16.6), () => drawLaptop(ctx, LX, LY));
  ctx.globalAlpha = prog(T, 16.3, 16.6);
  mono(ctx, "YOUR LAPTOP", LX, LY + 160, 24, BP, "center");
  mono(ctx, "trip.mp4 · 4 GB", LX, LY + 196, 26, C.ink, "center");
  ctx.globalAlpha = 1;
  // PC
  wipe(ctx, PX - 240, PY - 110, 520, 250, ex(T, 16.6, 17.4), () => drawPC(ctx, PX - 40, PY));
  ctx.globalAlpha = prog(T, 17.0, 17.4);
  mono(ctx, "DESKTOP PC", PX + 20, PY + 160, 24, BP, "center");
  ctx.globalAlpha = 1;

  // three detour routes and their items
  for (let i = 0; i < 3; i++) {
    const x = IT[i];
    const e = ex(T, enter[i], enter[i] + 0.5);
    const cu = prog(T, crosses[i], crosses[i] + 0.3);
    const dead = easeOut(cu);
    // dashed detour laptop -> item -> PC
    ctx.save();
    ctx.globalAlpha = 0.4 * e * (1 - 0.7 * dead);
    ctx.setLineDash([10, 10]);
    bpStroke(ctx, 2.5);
    ctx.beginPath();
    ctx.moveTo(LX + 60, LY - 110);
    ctx.quadraticCurveTo(x - 160, IY + 140, x - 20, IY + 105);
    ctx.moveTo(x + 20, IY + 105);
    ctx.quadraticCurveTo(x + 160, IY + 150, PX - 100, PY - 110);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    const shake = Math.sin(T * 80) * 9 * hit(T, crosses[i], 0.12);
    ctx.translate(x + shake, IY + (1 - e) * 40);
    ctx.scale(1.25, 1.25);
    ctx.globalAlpha = e * (1 - 0.35 * dead);
    if (i === 0) drawUSB(ctx, 0, 0);
    if (i === 1) drawCloud(ctx, 0, 0);
    if (i === 2) drawEnvelope(ctx, 0, 0);
    ctx.restore();
    ctx.globalAlpha = e;
    mono(ctx, ["USB STICK", "CLOUD", "EMAIL"][i], x, IY + 150, 26, BP, "center");
    ctx.globalAlpha = 1;
    cross(ctx, x, IY, 62, cu);
  }
  // cloud upload bar
  {
    const e = ex(T, enter[1] + 0.2, enter[1] + 0.6);
    const bu = prog(T, 17.35, 17.95);
    ctx.save();
    ctx.globalAlpha = e;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = BP;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(870, IY + 176, 180, 22, 11);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(874, IY + 180, 172 * (0.06 + 0.12 * bu), 14, 7);
    ctx.fillStyle = C.marigold;
    ctx.fill();
    mono(ctx, "3 hr", 960, IY + 234, 30, C.ink, "center");
    ctx.restore();
  }
  // TOO LARGE stamp
  {
    const s = pop(T, 18.75, 0.3, 2.4);
    if (s > 0) {
      ctx.save();
      ctx.translate(1270, IY + 92);
      ctx.rotate(-0.1);
      ctx.scale(s, s);
      ctx.fillStyle = C.vermilion;
      ctx.beginPath();
      ctx.roundRect(-96, -24, 192, 48, 6);
      ctx.fill();
      ctx.font = F.mono(24, 800);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText("TOO LARGE", 0, 8);
      ctx.restore();
    }
  }
  // the direct line
  {
    const u = ex(T, 20.333, 20.95);
    if (u > 0) {
      const xa = 540, xb = 1330;
      ctx.save();
      ctx.strokeStyle = C.marigold;
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.setLineDash([22, 16]);
      ctx.lineDashOffset = -(T - 20.333) * 60;
      ctx.beginPath();
      ctx.moveTo(xa, LY);
      ctx.lineTo(lerp(xa, xb, u), LY);
      ctx.stroke();
      ctx.restore();
      const fu = prog(T, 20.6, 21.15);
      if (fu > 0 && fu < 1) fileCard(ctx, lerp(xa, xb, easeInOut(fu)), LY - 6, 0.5, 0);
      const ck = prog(T, 21.1, 21.4);
      check(ctx, PX + 20, PY - 140, 34, ck);
      // ding ring on the PC
      const d = prog(T, 20.333, 21.0);
      if (d > 0 && d < 1) {
        ctx.strokeStyle = `rgba(232,163,23,${(0.7 * (1 - d)).toFixed(3)})`;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(LX + 180, LY, 40 + 90 * easeOutExpo(d), 0, TAU);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
};

// =====================================================================
// 4. NUDGE (21.33-26.67): a chat card
// =====================================================================
function dots(ctx: Ctx, x: number, y: number, T: number, a: number) {
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "#EFEDE7";
  ctx.beginPath();
  ctx.roundRect(x, y, 112, 62, 30);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    const b = Math.sin(T * 9 - i * 0.9);
    ctx.fillStyle = `rgba(119,115,107,${(0.5 + 0.5 * b).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x + 34 + i * 22, y + 31 - b * 5, 6.5, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}
function bubble(ctx: Ctx, x: number, y: number, lines: string[], s: number, size = 46) {
  if (s <= 0) return;
  ctx.font = F.thai(size, 600);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 64;
  const h = lines.length * (size * 1.4) + 30;
  ctx.save();
  ctx.translate(x, y + h / 2);
  ctx.scale(s, s);
  ctx.translate(0, -h / 2);
  ctx.fillStyle = "#EFEDE7";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, [34, 34, 34, 8]);
  ctx.fill();
  lines.forEach((l, i) => thai(ctx, l, 34, 8 + size * 1.02 + i * size * 1.4, size, C.ink, "left", 600));
  ctx.restore();
  return h;
}

const nudge: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  const focus = ex(T, 21.333, 22.0);
  const k = prog(T, 25.333, 26.6667); // riser
  const kk = k * k * k;
  // blurred desktop behind: big windows and stray file cards
  blurred(ctx, lerp(26, 9, focus) + 10 * k, () => {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(1 + 0.5 * kk, 1 + 0.5 * kk);
    ctx.translate(-W / 2, -H / 2);
    card(ctx, 120, 210, 620, 420, { fill: "rgba(255,255,255,0.75)", r: 26 });
    card(ctx, 1240, 150, 560, 380, { fill: "rgba(255,255,255,0.7)", r: 26 });
    card(ctx, 1150, 650, 640, 340, { fill: "rgba(255,255,255,0.6)", r: 26 });
    card(ctx, 140, 720, 520, 240, { fill: "rgba(248,217,138,0.7)", r: 26 });
    fileCard(ctx, 820 + Math.sin(T) * 30, 190, 1.4, -0.2);
    fileCard(ctx, 1080, 930 + Math.cos(T * 0.8) * 20, 1.2, 0.2);
    fileCard(ctx, 300, 640 + Math.sin(T * 0.7) * 24, 1.0, 0.1);
    ctx.restore();
  });
  ctx.save();
  cam(ctx, t, 5.33, 0.97, 1.03, 0, -10);
  // riser zoom into the card
  const z = 1 + 1.4 * kk;
  ctx.translate(W / 2, H / 2 + 20);
  ctx.scale(z, z);
  ctx.rotate(-0.025 * (1 - k) + 0.05 * kk);
  const buzz = hit(T, 21.8, 0.17);
  const bx = Math.sin(T * 95) * 15 * buzz;
  const by = Math.cos(T * 71) * 6 * buzz;
  const float = Math.sin(T * 1.3) * 10;
  ctx.translate(bx, by + float);
  const blurC = lerp(10, 0, focus) + 14 * clamp((k - 0.6) / 0.4);
  const enterS = lerp(0.92, 1, ex(T, 21.333, 22.0));
  ctx.scale(enterS, enterS);
  // buzz marks
  if (buzz > 0.05) {
    ctx.strokeStyle = `rgba(232,163,23,${buzz.toFixed(2)})`;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    for (const sd of [-1, 1]) for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(sd * 0, 0, 480 + i * 34 + (1 - buzz) * 30, sd > 0 ? -0.4 : Math.PI - 0.4, sd > 0 ? 0.4 : Math.PI + 0.4);
      ctx.stroke();
    }
  }
  blurred(ctx, blurC, () => {
    const cx = -410, cy = -350;
    card(ctx, cx, cy, 820, 710, { r: 44, shadow: 70, fill: "#FFFFFF" });
    // header
    ctx.fillStyle = "#F7F5F0";
    ctx.beginPath();
    ctx.roundRect(cx, cy, 820, 130, [44, 44, 0, 0]);
    ctx.fill();
    ctx.fillStyle = C.marigold;
    ctx.beginPath();
    ctx.arc(cx + 78, cy + 65, 40, 0, TAU);
    ctx.fill();
    thai(ctx, "ต", cx + 78, cy + 82, 48, "#fff", "center", 800);
    thai(ctx, "ต้น", cx + 140, cy + 62, 44, C.ink, "left", 800);
    ctx.fillStyle = C.green;
    ctx.beginPath();
    ctx.arc(cx + 148, cy + 96, 7, 0, TAU);
    ctx.fill();
    mono(ctx, "active now", cx + 166, cy + 103, 22, C.muted);
    ctx.fillStyle = C.line;
    ctx.fillRect(cx, cy + 130, 820, 2);
    mono(ctx, "TODAY 9:41", cx + 410, cy + 190, 20, C.muted, "center");
    // typing + bubbles
    const p1 = pop(T, 22.3333, 0.4, 2.0);
    const d1 = prog(T, 21.95, 22.05) * (T < 22.3333 ? 1 : 0);
    dots(ctx, cx + 40, cy + 225, T, d1);
    bubble(ctx, cx + 40, cy + 225, ["ลอง Yon สิ"], p1, 54);
    const p2 = pop(T, 24.0, 0.4, 2.0);
    const d2 = prog(T, 23.55, 23.65) * (T < 24.0 ? 1 : 0);
    dots(ctx, cx + 40, cy + 365, T, d2);
    bubble(ctx, cx + 40, cy + 365, ["โยนข้ามเครื่องได้เลย", "ไม่ต้องผ่านคลาวด์"], p2, 48);
    // input bar
    ctx.fillStyle = "#F3F1EC";
    ctx.beginPath();
    ctx.roundRect(cx + 34, cy + 608, 752, 68, 34);
    ctx.fill();
    thai(ctx, "พิมพ์ข้อความ…", cx + 74, cy + 653, 30, C.muted, "left", 500);
    ctx.fillStyle = C.marigold;
    ctx.beginPath();
    ctx.arc(cx + 744, cy + 642, 26, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
  // speed streaks + whiteout for the cut
  if (k > 0.05) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.strokeStyle = `rgba(232,163,23,${(0.5 * k).toFixed(2)})`;
    ctx.lineWidth = 3;
    const r = rng(77);
    ctx.beginPath();
    for (let i = 0; i < 40; i++) {
      const a = r() * TAU;
      const r0 = 420 + r() * 500 + 900 * kk;
      const len = 60 + 380 * kk * (0.4 + r());
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 0.62);
      ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len) * 0.62);
    }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = `rgba(243,241,236,${(0.75 * prog(T, 26.35, 26.667)).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
};

// =====================================================================
// 5. NEARBY (26.67-32): a field of blocks, pings and devices
// =====================================================================
const hash2 = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
interface Dev { ax: number; ay: number; cy: number; at: number; id: string; name: string }
const DEVS: Dev[] = [
  { ax: 470, ay: 715, cy: 610, at: 27.6, id: "DEV-001", name: "MacBook" },
  { ax: 1450, ay: 735, cy: 635, at: 28.9333, id: "DEV-002", name: "Desktop PC" },
  { ax: 965, ay: 570, cy: 480, at: 30.2667, id: "DEV-003", name: "iPhone" },
];
const PINGS = [27.3333, 28.6667, 30.0];

function blocks(ctx: Ctx, T: number) {
  const f = 880, hy = 410, hc = 280, ZS = 150;
  const zcam = T * 110;
  const k0 = Math.floor(zcam / ZS);
  const camX = 90 * Math.sin(T * 0.35);
  const BL = [6, 2.5, 0, 9];
  const bandOf = (z: number) => (z > 1500 ? 0 : z > 800 ? 1 : z < 330 ? 3 : 2);
  const row = (dst: Ctx, r: number, z: number) => {
    for (let c = -7; c <= 7; c++) {
      const hh = hash2(r, c);
      if (hh < 0.42) continue;
      const X = c * 230 + (hash2(c, r) - 0.5) * 110;
      const bw = 100 + hash2(r + 3, c) * 90;
      const bd = 90 + hash2(r, c + 9) * 70;
      const bh = 26 + hash2(r + 5, c + 2) * 150;
      const k = f / z, k2 = f / (z + bd);
      const sx = 960 + (X - camX) * k, sx2 = 960 + (X - camX) * k2;
      const hw = (bw / 2) * k, hw2 = (bw / 2) * k2;
      const yg = hy + hc * k, yt = hy + (hc - bh) * k;
      const yg2 = hy + hc * k2, yt2 = hy + (hc - bh) * k2;
      const fog = clamp(1 - z / 3100);
      dst.globalAlpha = 0.25 + 0.75 * fog;
      dst.fillStyle = "#F0E6D0";
      dst.beginPath();
      dst.moveTo(sx - hw, yt);
      dst.lineTo(sx + hw, yt);
      dst.lineTo(sx2 + hw2, yt2);
      dst.lineTo(sx2 - hw2, yt2);
      dst.fill();
      dst.fillStyle = "#CDBE9F";
      dst.beginPath();
      if (X - camX > 0) {
        dst.moveTo(sx - hw, yt);
        dst.lineTo(sx2 - hw2, yt2);
        dst.lineTo(sx2 - hw2, yg2);
        dst.lineTo(sx - hw, yg);
      } else {
        dst.moveTo(sx + hw, yt);
        dst.lineTo(sx2 + hw2, yt2);
        dst.lineTo(sx2 + hw2, yg2);
        dst.lineTo(sx + hw, yg);
      }
      dst.fill();
      dst.fillStyle = "#DCCFB2";
      dst.fillRect(sx - hw, yt, hw * 2, yg - yt);
    }
    dst.globalAlpha = 1;
  };
  // blurred depth bands are drawn sharp into half-res layers and blurred once
  for (let band = 0; band < 4; band++) {
    const l = BL[band] > 0 ? layerCtx(10 + band) : null;
    if (l) {
      l.setTransform(0.5, 0, 0, 0.5, 0, 0);
      l.clearRect(0, 0, W, H);
    }
    for (let i = 15; i >= 0; i--) {
      const r = k0 + i;
      const z = r * ZS - zcam + 170;
      if (z < 120 || bandOf(z) !== band) continue;
      row(l ?? ctx, r, z);
    }
    if (l) {
      ctx.save();
      ctx.filter = `blur(${BL[band]}px)`;
      ctx.drawImage(l.canvas, 0, 0, W, H);
      ctx.restore();
    }
  }
}

const nearby: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  // ground plane
  const hy = 410;
  const gg = ctx.createLinearGradient(0, hy, 0, H);
  gg.addColorStop(0, "rgba(239,230,211,0.0)");
  gg.addColorStop(0.25, "rgba(239,230,211,0.95)");
  gg.addColorStop(1, "#E6D9BC");
  ctx.fillStyle = gg;
  ctx.fillRect(0, hy, W, H - hy);
  ctx.save();
  cam(ctx, t, 5.33, 1.0, 1.06, 0, -14);
  blocks(ctx, T);
  // rings
  const CX = 960, CY = 830;
  for (const p of PINGS) {
    for (let j = 0; j < 3; j++) {
      const u = prog(T, p + j * 0.18, p + j * 0.18 + 1.9);
      if (u <= 0 || u >= 1) continue;
      const R = 1250 * easeOutExpo(u) ** 0.9;
      ctx.strokeStyle = `rgba(232,163,23,${(0.85 * (1 - u) ** 1.3).toFixed(3)})`;
      ctx.lineWidth = 9 * (1 - u) + 2;
      ctx.beginPath();
      ctx.ellipse(CX, CY, R, R * 0.27, 0, 0, TAU);
      ctx.stroke();
      if (j === 0) {
        ctx.fillStyle = `rgba(232,163,23,${(0.1 * (1 - u)).toFixed(3)})`;
        ctx.fill();
      }
    }
  }
  // this device
  const pulse = 1 + 0.15 * Math.sin(T * 5);
  ctx.fillStyle = "rgba(232,163,23,0.25)";
  ctx.beginPath();
  ctx.ellipse(CX, CY, 42 * pulse, 12 * pulse, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = C.marigold;
  ctx.beginPath();
  ctx.arc(CX, CY - 6, 14, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 4;
  ctx.stroke();

  // device cards
  for (const d of DEVS) {
    const s = pop(T, d.at, 0.5, 2.2);
    if (s <= 0) continue;
    const bob = Math.sin(T * 1.6 + d.ax) * 5;
    // stem + anchor
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(d.ax, d.cy + 50);
    ctx.lineTo(d.ax, lerp(d.cy + 50, d.ay, clamp(s)));
    ctx.stroke();
    ctx.fillStyle = C.marigold;
    ctx.beginPath();
    ctx.ellipse(d.ax, d.ay, 18 * clamp(s), 6 * clamp(s), 0, 0, TAU);
    ctx.fill();
    ctx.save();
    ctx.translate(d.ax, d.cy + bob);
    ctx.scale(Math.max(0, s), Math.max(0, s));
    card(ctx, -175, -50, 350, 100, { r: 22, shadow: 36 });
    ctx.fillStyle = C.marigoldSoft;
    ctx.beginPath();
    ctx.arc(-124, 0, 28, 0, TAU);
    ctx.fill();
    ctx.fillStyle = C.ink;
    if (d.id === "DEV-003") {
      ctx.beginPath();
      ctx.roundRect(-133, -17, 18, 32, 4);
      ctx.fill();
    } else if (d.id === "DEV-002") {
      ctx.fillRect(-140, -15, 32, 21);
      ctx.fillRect(-128, 8, 8, 6);
      ctx.fillRect(-136, 13, 24, 3);
    } else {
      ctx.fillRect(-137, -11, 26, 17);
      ctx.fillRect(-141, 10, 34, 4);
    }
    mono(ctx, d.id, -80, -10, 20, C.muted);
    ctx.font = F.grotesk(34, 800);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "left";
    ctx.fillText(d.name, -80, 28);
    ctx.fillStyle = C.green;
    ctx.beginPath();
    ctx.arc(150, -24, 7, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  headline(ctx, [{ text: "Finds what's " }, { text: "nearby.", italic: true }], 960, 290, 130, { align: "center", reveal: ex(T, 26.75, 27.3) });
};

// =====================================================================
// 6. PLATFORMS (32-37.33)
// =====================================================================
const PLAT = [
  { at: 32.0, label: "MACOS", title: "Apple Silicon", icon: "laptop" },
  { at: 32.6667, label: "MACOS", title: "Intel", icon: "laptop" },
  { at: 33.3333, label: "WINDOWS", title: "x64", icon: "win" },
  { at: 34.0, label: "WINDOWS", title: "ARM64", icon: "win" },
  { at: 34.6667, label: "IPHONE", title: "web link", icon: "phone" },
  { at: 35.3333, label: "ANDROID", title: "web link", icon: "phone2" },
];
function platIcon(ctx: Ctx, kind: string, cx: number, cy: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = C.ink;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 9;
  ctx.lineJoin = "round";
  if (kind === "laptop") {
    ctx.beginPath();
    ctx.roundRect(-70, -52, 140, 92, 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-96, 52, 192, 12, 6);
    ctx.fill();
  } else if (kind === "win") {
    const c = [C.marigold, C.peach, C.sky, C.marigoldSoft];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i === 0 ? C.ink : c[i];
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 4;
      const x = (i % 2) * 66 - 66, y = Math.floor(i / 2) * 66 - 66;
      ctx.fillRect(x + 2, y + 2, 60, 60);
      ctx.strokeRect(x + 2, y + 2, 60, 60);
    }
  } else {
    ctx.beginPath();
    ctx.roundRect(-42, -78, 84, 156, 18);
    ctx.stroke();
    ctx.beginPath();
    if (kind === "phone") ctx.roundRect(-16, -62, 32, 10, 5);
    else ctx.arc(0, -58, 6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = C.marigold;
    ctx.beginPath();
    ctx.roundRect(-26, -34, 52, 64, 8);
    ctx.fill();
  }
  ctx.restore();
}

const platforms: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  const k = prog(T, 36.0, 37.3333);
  const kk = k * k * k;
  ctx.save();
  cam(ctx, t, 5.33, 1.0, 1.04, 0, 0);
  const z = 1 + 0.55 * kk;
  ctx.translate(W / 2, H / 2);
  ctx.scale(z, z);
  ctx.translate(-W / 2, -H / 2);
  // pan: a step at cards 5 and 6, plus a slow drift
  const pan = 420 * ex(T, 34.6667, 35.2) + 420 * ex(T, 35.3333, 35.9) + 28 * (T - 32) + 500 * kk;
  const speed = (i: number) => {
    const u = prog(T, PLAT[i].at, PLAT[i].at + 0.55);
    return u > 0 && u < 1 ? 1 - u : 0;
  };
  ctx.save();
  ctx.translate(-pan, 0);
  PLAT.forEach((p, i) => {
    const u = ex(T, p.at, p.at + 0.55);
    if (u <= 0) return;
    const x = 160 + i * 420;
    const off = (1 - u) * 1150;
    const y = 450 + (i % 2 ? 26 : -10) + Math.sin(T * 1.1 + i) * 8;
    const sp = speed(i);
    const blur = sp * 10 + 10 * kk;
    // motion ghosts
    if (sp > 0.15) {
      for (let g = 1; g <= 3; g++) {
        ctx.globalAlpha = 0.1 * sp * (4 - g);
        card(ctx, x + off + g * 34 * sp, y, 380, 450, { r: 26 });
      }
      ctx.globalAlpha = 1;
    }
    blurred(ctx, blur, () => {
      ctx.save();
      ctx.translate(x + off + 190, y + 225);
      ctx.rotate((1 - u) * 0.08 + (i % 2 ? 0.012 : -0.012));
      ctx.translate(-190, -225);
      card(ctx, 0, 0, 380, 450, { r: 26, shadow: 40 });
      spacing(ctx, "4px");
      mono(ctx, p.label, 34, 62, 24, C.muted);
      spacing(ctx, "0px");
      mono(ctx, `0${i + 1} / 06`, 346, 62, 22, C.muted, "right");
      platIcon(ctx, p.icon, 190, 190);
      ctx.fillStyle = C.line;
      ctx.fillRect(34, 322, 312, 3);
      ctx.font = F.grotesk(p.title.length > 8 ? 42 : 52, 900);
      ctx.fillStyle = C.ink;
      ctx.textAlign = "left";
      ctx.fillText(p.title, 34, 392);
      ctx.fillStyle = C.marigold;
      ctx.fillRect(34, 414, 54 * u, 6);
      ctx.restore();
    });
  });
  ctx.restore();
  ctx.restore();
  headline(ctx, [{ text: "Mac, Windows, " }, { text: "and your phone.", italic: true }], 150, 290, 108, { reveal: ex(T, 32.0, 32.7) });
  // riser: speed lines
  if (k > 0.03) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    const r = rng(41);
    ctx.lineCap = "round";
    for (let i = 0; i < 70; i++) {
      const a = r() * TAU;
      const r0 = 300 + r() * 700 + 1000 * kk;
      const len = 80 + 520 * kk * (0.3 + r());
      ctx.strokeStyle = r() < 0.3 ? `rgba(232,163,23,${(0.75 * k).toFixed(2)})` : `rgba(19,20,25,${(0.35 * k).toFixed(2)})`;
      ctx.lineWidth = 2 + r() * 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 0.6);
      ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len) * 0.6);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = `rgba(19,20,25,${(0.85 * prog(T, 37.0, 37.3333)).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
};

// =====================================================================
// 7. SEALED (37.33-42.67)
// =====================================================================
function keyGlyph(ctx: Ctx, x: number, y: number, s: number, flip: number, col: string, a: number) {
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.scale(flip * s, s);
  ctx.strokeStyle = col;
  ctx.lineWidth = 11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.arc(-74, 0, 36, 0, TAU);
  ctx.moveTo(-38, 0);
  ctx.lineTo(92, 0);
  ctx.moveTo(58, 0);
  ctx.lineTo(58, 34);
  ctx.moveTo(92, 0);
  ctx.lineTo(92, 28);
  ctx.stroke();
  ctx.restore();
}
function padlock(ctx: Ctx, x: number, y: number, s: number, open: number, a: number) {
  if (a <= 0 || s <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = C.inkText;
  ctx.lineWidth = 15;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-40, 0);
  ctx.lineTo(-40, -44 - open * 30);
  ctx.arc(0, -44 - open * 30, 40, Math.PI, 0);
  ctx.lineTo(40, -44 - open * 30 + 40 + open * 14);
  ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.fillStyle = C.marigold;
  ctx.beginPath();
  ctx.roundRect(-70, -4, 140, 106, 20);
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.beginPath();
  ctx.arc(0, 40, 13, 0, TAU);
  ctx.fill();
  ctx.fillRect(-5, 42, 10, 28);
  ctx.restore();
}
function cursor(ctx: Ctx, x: number, y: number, s = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 34);
  ctx.lineTo(9, 26);
  ctx.lineTo(16, 42);
  ctx.lineTo(23, 39);
  ctx.lineTo(16, 24);
  ctx.lineTo(28, 24);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

const LOG = [
  { txt: "found DEV-002 at 192.168.1.24:53318", hl: "DEV-002" },
  { txt: "tls: 1.3, mutual", hl: "1.3" },
  { txt: "cert: Ed25519, pinned to the discovered device", hl: "Ed25519" },
  { txt: "device code: A1B2-C3D4", hl: "A1B2-C3D4" },
  { txt: "awaiting accept…", hl: "" },
];

const sealed: Scene = (ctx, t, T) => {
  darkBg(ctx);
  // glow + dot grid
  const lockHit = hit(T, 40.0, 0.5);
  const gl = ctx.createRadialGradient(1420, 470, 0, 1420, 470, 620);
  gl.addColorStop(0, `rgba(232,163,23,${(0.12 + 0.3 * lockHit).toFixed(3)})`);
  gl.addColorStop(1, "rgba(232,163,23,0)");
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(236,232,223,0.07)";
  for (let gx = 40; gx < W; gx += 48) for (let gy = 40; gy < H; gy += 48) ctx.fillRect(gx + ((T * 6) % 48) - 48, gy, 3, 3);
  ctx.save();
  cam(ctx, t, 5.33, 1.0, 1.035, -10, -6);

  headline(ctx, [{ text: "Sealed " }, { text: "end to end.", italic: true }], 100, 290, 112, { color: C.inkText, reveal: ex(T, 37.4, 38.1) });

  // terminal
  const pu = ex(T, 37.333, 37.8);
  ctx.save();
  ctx.translate((1 - pu) * -700, 0);
  card(ctx, 100, 370, 830, 400, { fill: "#1A1B21", r: 22, shadow: 50 });
  ctx.strokeStyle = "#2E2F38";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(100, 370, 830, 400, 22);
  ctx.stroke();
  [C.vermilion, C.marigold, C.green].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(140 + i * 30, 406, 8, 0, TAU);
    ctx.fill();
  });
  mono(ctx, "yon · connection", 910, 412, 22, "rgba(236,232,223,0.45)", "right");
  ctx.fillStyle = "#2E2F38";
  ctx.fillRect(100, 436, 830, 2);
  LOG.forEach((l, i) => {
    const a = 37.6 + i * 0.48;
    const u = prog(T, a, a + 0.42);
    if (u <= 0) return;
    const y = 496 + i * 52;
    mono(ctx, "→", 136, y, 24, C.marigold);
    const shown = l.txt.slice(0, Math.floor(u * l.txt.length));
    const caret = u < 1 || (i === 4 && Math.floor(T * 2.5) % 2 === 0) ? "▍" : "";
    ctx.font = F.mono(24, 500);
    ctx.textAlign = "left";
    const col = i === 4 ? C.marigold : C.inkText;
    // draw the highlighted token in marigold when fully typed
    const idx = l.hl ? l.txt.indexOf(l.hl) : -1;
    if (idx >= 0 && shown.length > idx) {
      const pre = shown.slice(0, idx);
      const hlTxt = shown.slice(idx, idx + l.hl.length);
      const post = shown.slice(idx + l.hl.length);
      ctx.fillStyle = col;
      ctx.fillText(pre, 176, y);
      const w1 = ctx.measureText(pre).width;
      ctx.fillStyle = C.marigold;
      ctx.fillText(hlTxt, 176 + w1, y);
      const w2 = ctx.measureText(hlTxt).width;
      ctx.fillStyle = col;
      ctx.fillText(post + caret, 176 + w1 + w2, y);
    } else {
      ctx.fillStyle = col;
      ctx.fillText(shown + caret, 176, y);
    }
  });
  ctx.restore();

  // chips
  ["TLS 1.3", "MUTUAL AUTH", "PINNED CERT"].forEach((s, i) => {
    const p = pop(T, 40.0 + i * 0.14, 0.4, 2.2);
    if (p <= 0) return;
    ctx.save();
    const x = [100, 290, 530][i];
    ctx.translate(x, 840);
    ctx.scale(p, p);
    ctx.font = F.mono(22, 700);
    const w = ctx.measureText(s).width + 40;
    ctx.strokeStyle = C.marigold;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(0, -30, w, 44, 22);
    ctx.stroke();
    ctx.fillStyle = C.marigold;
    ctx.textAlign = "left";
    ctx.fillText(s, 20, 0);
    ctx.restore();
  });

  // divider
  ctx.fillStyle = "rgba(236,232,223,0.12)";
  ctx.fillRect(989, 340, 2, 600);

  // keys: meet at 38.667, hold, then become a padlock that shuts at 40.0
  const KX = 1420, KY = 470;
  const kin = ex(T, 37.9, 38.667);
  const kOut = 1 - ex(T, 39.3, 39.7);
  const kl = lerp(1130, KX - 88, kin);
  const kr = lerp(1710, KX + 88, kin);
  const kb = hit(T, 38.667, 0.3);
  if (kOut > 0.01) {
    keyGlyph(ctx, kl, KY + Math.sin(T * 3) * 3, 1.05 * kOut, 1, C.marigold, kin * kOut);
    keyGlyph(ctx, kr, KY + Math.sin(T * 3 + 2) * 3, 1.05 * kOut, -1, C.inkText, kin * kOut);
  }
  if (T >= 38.667) {
    const ru = prog(T, 38.667, 39.5);
    ctx.strokeStyle = `rgba(232,163,23,${(0.8 * (1 - ru)).toFixed(3)})`;
    ctx.lineWidth = 8 * (1 - ru) + 1;
    ctx.beginPath();
    ctx.arc(KX, KY, 30 + 240 * easeOutExpo(ru), 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.3;
      star4(ctx, KX + Math.cos(a) * (60 + kb * 0 + 130 * easeOutExpo(ru)), KY + Math.sin(a) * (40 + 90 * easeOutExpo(ru)), 18 * (1 - ru), C.marigoldSoft, 1 - ru);
    }
  }
  const lin = pop(T, 39.3, 0.35, 2.0);
  const shut = easeOutBack(prog(T, 39.95, 40.12), 2.2);
  const lockBounce = 1 + 0.12 * hit(T, 40.0, 0.25);
  padlock(ctx, KX, KY - 10, 1.05 * clamp(lin, 0, 1.15) * lockBounce, T < 39.95 ? 1 : 1 - clamp(shut), clamp(lin));
  if (T >= 40.0) {
    const ru = prog(T, 40.0, 40.8);
    ctx.strokeStyle = `rgba(232,163,23,${(0.9 * (1 - ru)).toFixed(3)})`;
    ctx.lineWidth = 10 * (1 - ru) + 1;
    ctx.beginPath();
    ctx.arc(KX, KY + 20, 70 + 280 * easeOutExpo(ru), 0, TAU);
    ctx.stroke();
  }

  // accept dialog
  const dp = pop(T, 41.0, 0.45, 1.9);
  if (dp > 0) {
    const DX = 1040, DY = 590, DW = 760, DH = 340;
    const press = T >= 41.8 ? Math.sin(clamp((T - 41.8) / 0.22) * Math.PI) : 0;
    ctx.save();
    ctx.translate(DX + DW / 2, DY + DH / 2);
    ctx.scale(Math.max(0, dp), Math.max(0, dp));
    ctx.translate(-DW / 2, -DH / 2);
    card(ctx, 0, 0, DW, DH, { r: 30, shadow: 60, fill: "#FBFAF7" });
    mono(ctx, "YON · INCOMING TRANSFER", 40, 56, 21, C.muted);
    ctx.font = F.grotesk(36, 800);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "left";
    ctx.fillText("MacBook wants to send 1 file", 40, 118);
    // file row
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(40, 150, DW - 80, 80, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.marigold;
    ctx.beginPath();
    ctx.moveTo(62, 168);
    ctx.lineTo(86, 168);
    ctx.lineTo(96, 178);
    ctx.lineTo(96, 212);
    ctx.lineTo(62, 212);
    ctx.fill();
    ctx.font = F.grotesk(30, 800);
    ctx.fillStyle = C.ink;
    ctx.fillText("trip.mp4", 116, 203);
    mono(ctx, "4 GB", DW - 62, 202, 26, C.muted, "right");
    // buttons
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(40, 256, 300, 62, 31);
    ctx.stroke();
    ctx.font = F.grotesk(28, 800);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "center";
    ctx.fillText("Decline", 190, 297);
    const done = T >= 41.95;
    ctx.save();
    ctx.translate(540, 287);
    const bs = 1 - 0.07 * press;
    ctx.scale(bs, bs);
    ctx.fillStyle = done ? C.green : C.marigold;
    ctx.beginPath();
    ctx.roundRect(-180, -31, 360, 62, 31);
    ctx.fill();
    ctx.fillStyle = done ? "#fff" : C.ink;
    ctx.font = F.grotesk(28, 800);
    ctx.textAlign = "center";
    ctx.fillText(done ? "Accepted" : "Accept", 0, 10);
    if (T >= 41.8) {
      const rp = prog(T, 41.8, 42.3);
      ctx.strokeStyle = `rgba(232,163,23,${(0.8 * (1 - rp)).toFixed(3)})`;
      ctx.lineWidth = 6 * (1 - rp) + 1;
      ctx.beginPath();
      ctx.roundRect(-180 - 60 * rp, -31 - 30 * rp, 360 + 120 * rp, 62 + 60 * rp, 31 + 30 * rp);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
    // cursor travels to Accept
    const cu = easeInOut(prog(T, 41.3, 41.8));
    const cx0 = DX + 540, cy0 = DY + 287;
    cursor(ctx, lerp(DX + 700, cx0 + 50, cu), lerp(DY + 80, cy0 + 4, cu) + press * 3, 1 - 0.1 * press);
  }
  ctx.restore();
};

// =====================================================================
// 8. NO CLOUD (42.67-48)
// =====================================================================
interface Shard { a: number; v: number; k: number; s: number; rot: number; spin: number; face: string; z: number }
const shards: Shard[] = (() => {
  const r = rng(99);
  return Array.from({ length: 64 }, (_, i) => ({
    a: (i / 64) * TAU + (r() - 0.5) * 0.3, v: 1100 + r() * 2200, k: 2.2 + r() * 1.6, s: 0.5 + r() * 1.3,
    rot: r() * TAU, spin: (r() - 0.5) * 6, face: COLD_FACES[Math.floor(r() * 4)], z: r(),
  })).sort((a, b) => a.s - b.s);
})();
const debris = (() => {
  const r = rng(123);
  return Array.from({ length: 34 }, () => ({ x: 140 + r() * (W - 280), y: r() < 0.5 ? 160 + r() * 200 : 880 + r() * 40, r: 8 + r() * 18, ph: r() * 2.2, per: 0.8 + r() * 0.8, sq: r() < 0.4 }));
})();

const nocloud: Scene = (ctx, t, T) => {
  darkBg(ctx);
  const S = 42.6667;
  const tau = Math.max(0, T - S);
  ctx.save();
  cam(ctx, t, 5.33, 1.0, 1.1, 0, 0);
  // explosion of cards (blurred depth bands go through half-res layers, blurred once)
  const SB = (sz: number) => (sz > 1.45 ? 7 : sz > 1.0 ? 2 : 0);
  const sl: Record<number, CanvasRenderingContext2D> = {};
  for (const bl of [2, 7]) {
    sl[bl] = layerCtx(20 + bl);
    sl[bl].setTransform(0.5, 0, 0, 0.5, 0, 0);
    sl[bl].clearRect(0, 0, W, H);
  }
  for (const s of shards) {
    const dst = sl[SB(s.s)] ?? ctx;
    const R = (s.v / s.k) * (1 - Math.exp(-tau * s.k)) + 18 * tau;
    const sp = s.v * Math.exp(-tau * s.k);
    const x = 960 + Math.cos(s.a) * R * 1.18;
    const y = 560 + Math.sin(s.a) * R * 0.78;
    const a = 0.95 * prog(tau, 0, 0.05) * lerp(1, 0.45, prog(tau, 0.5, 3));
    const sc = s.s * (0.7 + 0.5 * easeOut(prog(tau, 0, 0.6)));
    const ang = Math.atan2(Math.sin(s.a) * 0.78, Math.cos(s.a) * 1.18);
    // streaks along velocity
    const len = Math.min(700, sp * 0.11);
    if (len > 12 && tau > 0) {
      dst.save();
      dst.translate(x, y);
      dst.rotate(ang);
      const gr = dst.createLinearGradient(-len, 0, 0, 0);
      gr.addColorStop(0, "rgba(243,241,236,0)");
      gr.addColorStop(1, `rgba(243,241,236,${(0.34 * a).toFixed(3)})`);
      dst.fillStyle = gr;
      dst.fillRect(-len, -24 * sc, len, 48 * sc);
      dst.restore();
    }
    mini(dst, x, y, sc, s.rot + s.spin * tau * Math.exp(-tau * 0.8), s.face, a);
  }
  for (const bl of [2, 7]) {
    ctx.save();
    ctx.filter = `blur(${bl}px)`;
    ctx.drawImage(sl[bl].canvas, 0, 0, W, H);
    ctx.restore();
  }

  // shockwave
  const wu = prog(tau, 0, 0.9);
  if (wu > 0 && wu < 1) {
    ctx.strokeStyle = `rgba(232,163,23,${(0.8 * (1 - wu)).toFixed(3)})`;
    ctx.lineWidth = 14 * (1 - wu) + 1;
    ctx.beginPath();
    ctx.ellipse(960, 560, 100 + 1500 * easeOutExpo(wu), 60 + 900 * easeOutExpo(wu), 0, 0, TAU);
    ctx.stroke();
  }

  // NO CLOUD.
  ctx.font = F.grotesk(300, 900);
  const w300 = ctx.measureText("NO CLOUD.").width;
  const size = Math.min(300, (1720 / w300) * 300);
  const u = prog(tau, 0, 0.55);
  const s = lerp(2.4, 1, easeOutBack(u, 2.4));
  const shake = Math.sin(T * 80) * 9 * hit(T, S, 0.3);
  ctx.save();
  ctx.translate(960 + shake, 600 + shake * 0.5);
  ctx.scale(s, s);
  ctx.globalAlpha = prog(tau, 0, 0.05);
  ctx.font = F.grotesk(size, 900);
  ctx.textAlign = "left";
  const wa = ctx.measureText("NO ").width;
  const wb = ctx.measureText("CLOUD.").width;
  const x0 = -(wa + wb) / 2;
  ctx.fillStyle = C.marigold;
  ctx.fillText("NO ", x0, 0);
  ctx.fillStyle = C.inkText;
  ctx.fillText("CLOUD.", x0 + wa, 0);
  ctx.restore();

  // caption
  const cu = ex(T, 43.4, 44.0);
  ctx.save();
  ctx.globalAlpha = cu;
  mono(ctx, "files go straight from one device to the other, on your Wi-Fi", 960, 790 + (1 - cu) * 18, 32, C.inkText, "center");
  ctx.fillStyle = C.marigold;
  ctx.fillRect(960 - 400 * cu, 830, 800 * cu, 4);
  ctx.restore();

  // debris glitters
  if (T >= 45.3333) {
    const tt = T - 45.3333;
    for (const d of debris) {
      const ph = (tt - d.ph * 0.4) / d.per;
      if (ph < 0) continue;
      const k = Math.sin(clamp(ph % 1) * Math.PI);
      if (d.sq) {
        ctx.globalAlpha = 0.7 * k;
        ctx.fillStyle = C.marigoldSoft;
        ctx.fillRect(d.x, d.y - tt * 6, d.r * 0.6, d.r * 0.6);
        ctx.globalAlpha = 1;
      } else star4(ctx, d.x, d.y - tt * 6, d.r * k, C.inkText, 0.9, ph * 0.7);
    }
  }
  ctx.restore();
};

export const scenesA: Record<string, Scene> = { cold, title, tagline, problem, nudge, nearby, platforms, sealed, nocloud };
