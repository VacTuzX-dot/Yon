// Scenes 48-90 s of the editorial reel. Every scene is a pure function of time;
// visual events land on the cue times in timeline.json (the music is built from
// the same cues).
import timeline from "./timeline.json";
import {
  C, F, H, W, arcPoint, blurred, card, check, clamp, dashedArc, easeIn, easeInOut, easeOut, easeOutBack, easeOutExpo, fileCard, headline, hit, lerp,
  mono, paperBg, prog, rng, thai, typed, type Ctx, type Scene,
} from "./kit";

const TAU = Math.PI * 2;

// ---------- small helpers ----------
/** Slow camera drift: every scene moves, nothing is ever static. */
function drift(ctx: Ctx, T: number, amp = 10) {
  ctx.translate(Math.sin(T * 0.37) * amp, Math.cos(T * 0.29) * amp * 0.6);
}

/** Runs `fn` in a local frame: translated to (x,y), then rotated, then scaled. */
function at(ctx: Ctx, x: number, y: number, rot: number, scale: number, fn: () => void) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  fn();
  ctx.restore();
}

/** A pill with centred text; returns its width. */
function pill(ctx: Ctx, text: string, cx: number, cy: number, font: string, fg: string, bg: string, padX: number, h: number, stroke?: string) {
  ctx.save();
  ctx.font = font;
  const w = ctx.measureText(text).width + padX * 2;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + 2);
  ctx.restore();
  return w;
}

function sparkle(ctx: Ctx, x: number, y: number, r: number, color: string, a = 1) {
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? r * 0.22 : r;
    const ang = (i / 8) * TAU - Math.PI / 2;
    ctx[i ? "lineTo" : "moveTo"](x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A padlock glyph centred on (x,y), about 26px wide at s=1. */
function lock(ctx: Ctx, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, -4, 8, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(-13, -4, 26, 20, 5);
  ctx.fill();
  ctx.restore();
}

/** The Yon app icon: marigold to peach tile with the Thai word for "toss". */
function yonIcon(ctx: Ctx, cx: number, cy: number, size: number, alpha = 1, glyph: "thai" | "arc" = "thai") {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy);
  ctx.shadowColor = "rgba(19,20,25,0.28)";
  ctx.shadowBlur = size * 0.22;
  ctx.shadowOffsetY = size * 0.08;
  const g = ctx.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2);
  g.addColorStop(0, C.marigold);
  g.addColorStop(1, C.peach);
  ctx.beginPath();
  ctx.roundRect(-size / 2, -size / 2, size, size, size * 0.26);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = "transparent";
  // glossy top light
  const hl = ctx.createLinearGradient(0, -size / 2, 0, 0);
  hl.addColorStop(0, "rgba(255,255,255,0.42)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.roundRect(-size / 2, -size / 2, size, size / 2, [size * 0.26, size * 0.26, 0, 0]);
  ctx.fillStyle = hl;
  ctx.fill();
  if (glyph === "thai") {
    ctx.font = F.thai(size * 0.44, 800);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("โยน", 0, size * 0.17);
  } else {
    // the toss arc: a dashed flight path ending in a solid dot
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = "round";
    ctx.setLineDash([size * 0.11, size * 0.09]);
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) {
      const [x, y] = arcPoint(-size * 0.3, size * 0.2, size * 0.26, size * 0.2, size * 0.5, i / 30);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(size * 0.28, size * 0.2, size * 0.085, 0, TAU);
    ctx.fillStyle = C.ink;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-size * 0.3, size * 0.2, size * 0.05, 0, TAU);
    ctx.fillStyle = C.white;
    ctx.fill();
  }
  ctx.restore();
}

// =====================================================================
// 06 CHECKED  48 - 53.33
// =====================================================================
const CH_S: [number, number] = [360, 770];
const CH_E: [number, number] = [1510, 770];
const CK = 1.3; // chunk / card scale
const CH_LIFT = 210;
const CH_N = 12;
const chOrder = (() => {
  const r = rng(11);
  const idx = Array.from({ length: CH_N }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx; // chunk i starts running as the chOrder[i]-th
})();
const chJit = (() => {
  const r = rng(23);
  return Array.from({ length: CH_N }, () => ({ x: (r() - 0.5) * 120, y: (r() - 0.5) * 90, rot: (r() - 0.5) * 0.9 }));
})();

const checked: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  ctx.save();
  drift(ctx, T, 9);
  // soft colour behind the frosted panel, blurred once as a group
  blurred(ctx, 46, () => {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = C.marigold;
    ctx.beginPath();
    ctx.arc(480 + Math.sin(T * 0.5) * 50, 720, 210, 0, TAU);
    ctx.fill();
    ctx.fillStyle = C.sky;
    ctx.beginPath();
    ctx.arc(1480, 330 + Math.cos(T * 0.4) * 40, 250, 0, TAU);
    ctx.fill();
    ctx.fillStyle = C.peach;
    ctx.beginPath();
    ctx.arc(1160, 860, 190, 0, TAU);
    ctx.fill();
  });
  // frosted glass panel
  ctx.save();
  ctx.shadowColor = "rgba(19,20,25,0.12)";
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 20;
  ctx.beginPath();
  ctx.roundRect(150, 170, 1620, 760, 44);
  ctx.fillStyle = "rgba(255,255,255,0.46)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  const sheen = ctx.createLinearGradient(150, 170, 150, 500);
  sheen.addColorStop(0, "rgba(255,255,255,0.45)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.restore();

  headline(ctx, [{ text: "Checked " }, { text: "when it lands.", italic: true }], 230, 385, 124, { reveal: easeOut(prog(t, 0.1, 1.0)) });
  ctx.globalAlpha = prog(t, 0.5, 1.0);
  mono(ctx, "SHA-256 ✓  every file, on arrival", 234, 450, 28, C.ink);
  ctx.globalAlpha = 1;

  // the path the chunks follow
  ctx.globalAlpha = 0.35 * prog(t, 0.2, 0.7);
  dashedArc(ctx, CH_S[0], CH_S[1], CH_E[0], CH_E[1], CH_LIFT, 1, C.ink, 2.5);
  ctx.globalAlpha = 1;

  const assemble = easeInOut(prog(t, 3.3, 3.6));
  if (t < 0.05) {
    // the intact card the instant before it cracks
    fileCard(ctx, CH_S[0], CH_S[1], CK, 0);
  } else if (t < 3.78) {
    const fade = 1 - prog(t, 3.62, 3.78);
    ctx.save();
    ctx.globalAlpha = fade;
    const fly = easeOutBack(prog(t, 0, 0.35));
    for (let i = 0; i < CH_N; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const st = 0.4 + chOrder[i] * 0.05;
      const raw = prog(t, st, st + 2.38);
      const v = raw * 16;
      const k = Math.floor(v);
      const us = (k + easeOutExpo(v - k)) / 16; // quantised: every tick is visible
      const [px, py] = arcPoint(CH_S[0], CH_S[1], CH_E[0], CH_E[1], CH_LIFT, Math.min(1, us));
      const hop = raw > 0 && raw < 1 ? -14 * Math.sin(easeOutExpo(v - k) * Math.PI) : 0;
      const pitchX = lerp(55 * CK * 1.3, 55 * CK, assemble);
      const pitchY = lerp(46.6 * CK * 1.3, 46.6 * CK, assemble);
      const cell = { x: (col - 1.5) * pitchX, y: (row - 1) * pitchY };
      const j = chJit[i];
      const free = fly * (1 - assemble);
      const ox = lerp(cell.x, j.x, free);
      const oy = lerp(cell.y, j.y, free);
      at(ctx, px + ox, py + oy + hop, j.rot * free, 1, () => {
        const sz = lerp(46, 55, assemble) * CK;
        ctx.beginPath();
        ctx.roundRect(-sz / 2, -sz * 0.43, sz, sz * 0.86, 10);
        ctx.fillStyle = C.white;
        ctx.shadowColor = "rgba(19,20,25,0.18)";
        ctx.shadowBlur = 14;
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = C.marigold;
        ctx.lineWidth = 3.5;
        ctx.stroke();
      });
    }
    ctx.restore();
  }
  if (t >= 3.6) {
    const a = prog(t, 3.62, 3.78);
    ctx.globalAlpha = a;
    fileCard(ctx, CH_E[0], CH_E[1], CK + 0.14 * hit(t, 3.6, 0.3), 0);
    ctx.globalAlpha = 1;
    // click ring
    const c = prog(t, 3.6, 3.95);
    if (c > 0 && c < 1) {
      ctx.strokeStyle = `rgba(232,163,23,${1 - c})`;
      ctx.lineWidth = 6 * (1 - c) + 1;
      ctx.beginPath();
      ctx.ellipse(CH_E[0], CH_E[1], 170 + 120 * easeOut(c), 120 + 80 * easeOut(c), 0, 0, TAU);
      ctx.stroke();
    }
  }
  // green check + ring burst at 52.0
  if (t >= 4.0) {
    const cx = CH_E[0] + 136;
    const cy = CH_E[1] - 100;
    const u = prog(t, 4.0, 4.5);
    check(ctx, cx, cy, 50, u);
    for (let k = 0; k < 2; k++) {
      const b = prog(t, 4.0 + k * 0.12, 4.75 + k * 0.12);
      if (b > 0 && b < 1) {
        ctx.strokeStyle = `rgba(63,174,107,${0.7 * (1 - b)})`;
        ctx.lineWidth = 7 * (1 - b) + 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 50 + 170 * easeOutExpo(b), 0, TAU);
        ctx.stroke();
      }
    }
    // little rays
    const rb = prog(t, 4.0, 4.6);
    if (rb > 0 && rb < 1) {
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        const r0 = 70 + 70 * easeOutExpo(rb);
        const r1 = r0 + 26 * (1 - rb);
        ctx.globalAlpha = 1 - rb;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = prog(t, 4.2, 4.6);
    mono(ctx, "SHA-256  MATCH", CH_E[0], CH_E[1] + 122, 24, C.green, "center");
    ctx.globalAlpha = 1;
  }
  ctx.restore();
};

// =====================================================================
// 06B ZERO  53.33 - 56
// =====================================================================
const zero: Scene = (ctx, t, T) => {
  ctx.fillStyle = C.marigold;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  const z = 1 + 0.035 * prog(t, 0, 2.67);
  ctx.translate(W / 2 + Math.sin(T * 0.6) * 8, H / 2);
  ctx.scale(z, z);
  ctx.translate(-W / 2, -H / 2);
  // concentric rings pulse out of the slam
  const pulse = hit(t, 0, 0.5);
  ctx.strokeStyle = "rgba(19,20,25,0.13)";
  ctx.lineWidth = 3;
  for (let i = 1; i <= 6; i++) {
    ctx.beginPath();
    ctx.arc(1580, 410, i * 105 + pulse * 40 * (7 - i) * 0.3 + easeOutExpo(prog(t, 0, 0.6)) * 30, 0, TAU);
    ctx.stroke();
  }
  // big zero
  const u = easeOutBack(prog(t, 0, 0.3), 2.2);
  ctx.save();
  ctx.font = F.grotesk(470, 900);
  ctx.textBaseline = "alphabetic";
  const w0 = ctx.measureText("0").width;
  ctx.translate(160 + w0 / 2, 650 - 170);
  ctx.scale(lerp(1.7, 1, u), lerp(1.7, 1, u));
  ctx.fillStyle = C.ink;
  ctx.textAlign = "center";
  ctx.fillText("0", 0, 170);
  ctx.restore();
  // "accounts." in serif italic, slides in right behind the zero
  const ua = easeOutExpo(prog(t, 0.05, 0.5));
  ctx.save();
  ctx.font = F.serif(250);
  ctx.globalAlpha = ua;
  ctx.fillStyle = C.ink;
  ctx.fillText("accounts.", 160 + w0 + 40 + (1 - ua) * 120, 650);
  ctx.restore();
  // rule + mono
  ctx.fillStyle = C.ink;
  ctx.fillRect(160, 725, 1600 * easeOut(prog(t, 0.2, 0.9)), 4);
  ctx.globalAlpha = prog(t, 0.4, 0.8);
  mono(ctx, "no sign-up · no server in the middle on your Wi-Fi", 160, 795, 34, C.ink);
  ctx.globalAlpha = 1;
  // things you do not need, crossed out one by one
  const items = ["SIGN-UP", "LOGIN", "CLOUD"];
  let bx = 160;
  items.forEach((s, i) => {
    const a = easeOutBack(prog(t, 0.6 + i * 0.22, 0.85 + i * 0.22));
    if (a <= 0) return;
    ctx.save();
    ctx.font = F.mono(28, 700);
    const w = ctx.measureText(s).width + 56;
    at(ctx, bx + w / 2, 900, 0, a, () => {
      ctx.beginPath();
      ctx.roundRect(-w / 2, -30, w, 60, 30);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = F.mono(28, 700);
      ctx.fillStyle = C.ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s, 0, 2);
      const x = easeOut(prog(t, 0.95 + i * 0.22, 1.2 + i * 0.22));
      ctx.strokeStyle = C.vermilion;
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-w / 2 + 10, 12);
      ctx.lineTo(-w / 2 + 10 + (w - 20) * x, 12 - 24 * x);
      ctx.stroke();
    });
    ctx.restore();
    bx += w + 24;
  });
  ctx.restore();
};

// =====================================================================
// 07 ANY SIZE  56 - 58.67
// =====================================================================
const anysize: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  ctx.save();
  drift(ctx, T, 8);
  // a second document, out of focus behind
  blurred(ctx, 9, () => {
    at(ctx, 1040, 560, 0.05, 1, () => card(ctx, -700, -330, 1400, 660, { fill: "rgba(255,255,255,0.7)", r: 26, shadow: 30 }));
  });
  const slide = easeOutExpo(prog(t, 0, 0.55));
  const cx = 260 + (1 - slide) * 1700;
  const rot = (1 - slide) * -0.06;
  at(ctx, cx + 700, 550, rot, 1, () => {
    card(ctx, -700, -330, 1400, 660, { r: 28, shadow: 56 });
    const L = -640;
    // top strip
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.roundRect(L, -290, 420, 48, 24);
    ctx.fill();
    mono(ctx, "FILE NUMBER: YON-001", L + 26, -257, 24, C.white);
    ctx.fillStyle = C.line;
    ctx.fillRect(L, -218, 1280, 3);
    headline(ctx, [{ text: "1 GB file → " }, { text: "a few MB of memory", italic: true }], L, -130, 68, { reveal: easeOut(prog(t, 0.2, 0.8)) });
    ctx.save();
    ctx.globalAlpha = prog(t, 0.35, 0.8);
    ctx.font = F.serif(48);
    ctx.fillStyle = C.muted;
    ctx.fillText("Whole folders arrive whole.", L, -56);
    ctx.restore();
    // bar chart: file size vs memory, cell by cell
    const cellW = 34;
    const gap = 4;
    const nFile = 27;
    const bx = L + 250;
    const ticks = prog(t, 0.4, 1.8);
    const nf = Math.floor(ticks * nFile + 0.0001);
    const nm = Math.min(1, Math.floor(ticks * 4));
    ctx.font = F.mono(24, 700);
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.muted;
    ctx.textAlign = "left";
    ctx.fillText("FILE SIZE", L, 70);
    ctx.fillText("MEMORY", L, 170);
    for (let i = 0; i < nf; i++) {
      ctx.beginPath();
      ctx.roundRect(bx + i * (cellW + gap), 40, cellW, 60, 6);
      ctx.fillStyle = i === nf - 1 ? C.marigold : C.ink;
      ctx.fill();
    }
    for (let i = 0; i < nm; i++) {
      ctx.beginPath();
      ctx.roundRect(bx + i * (cellW + gap), 140, cellW, 60, 6);
      ctx.fillStyle = C.green;
      ctx.fill();
    }
    ctx.font = F.grotesk(40, 900);
    ctx.fillStyle = C.ink;
    if (nf > 0) ctx.fillText(nf >= nFile ? "1 GB" : `${Math.round((nf / nFile) * 1000)} MB`, bx + nf * (cellW + gap) + 18, 70);
    if (nm > 0) {
      ctx.fillStyle = C.green;
      ctx.fillText(ticks >= 1 ? "a few MB" : "…", bx + (cellW + gap) + 18, 170);
    }
    // baseline ticks
    ctx.fillStyle = C.line;
    ctx.fillRect(bx - 12, 30, 3, 190);
    mono(ctx, "STREAMED, NOT LOADED", L + 1280, 280, 22, C.muted, "right");
  });
  ctx.restore();
};

// =====================================================================
// 07B BREATHER  58.67 - 66.67
// =====================================================================
function tossCard(ctx: Ctx, t: number, a: number, b: number, p: [number, number, number, number], lift: number, name: string, size: string) {
  const u = prog(t, a, b);
  const fade = 1 - prog(t, b + 0.3, b + 1.3);
  if (u <= 0 || fade <= 0) return;
  ctx.save();
  ctx.globalAlpha = fade;
  const e = easeInOut(u);
  dashedArc(ctx, p[0], p[1], p[2], p[3], lift, Math.max(0.02, e), C.ink, 3);
  const [x, y] = arcPoint(p[0], p[1], p[2], p[3], lift, e);
  const dir = p[2] > p[0] ? 1 : -1;
  const rot = dir * (lerp(-0.3, 0.22, e) + 0.05 * Math.sin(t * 2.4));
  const land = hit(t, b, 0.4);
  fileCard(ctx, x, y, 0.92 + 0.06 * land, rot, name, size);
  ctx.restore();
}

const breather: Scene = (ctx, t, T) => {
  paperBg(ctx, T, 0.4);
  const k = easeIn(prog(t, 6.667, 8));
  ctx.save();
  // riser: the whole frame accelerates toward the camera
  const z = 1 + k * 1.5;
  ctx.translate(W / 2, H / 2);
  ctx.scale(z, z);
  ctx.rotate(k * 0.05);
  ctx.translate(-W / 2, -H / 2);
  drift(ctx, T, 7);
  // out-of-focus floaters, one blur for the group
  blurred(ctx, 11, () => {
    ctx.globalAlpha = 0.6;
    const fl: [number, number, number, string, string][] = [
      [1560, 320, 0.25, "notes.md", "12 KB"],
      [1120, 850, -0.2, "scan.pdf", "8 MB"],
      [420, 700, 0.15, "demo.mov", "900 MB"],
    ];
    fl.forEach(([x, y, r, n, s], i) => {
      const dx = Math.sin(T * 0.3 + i * 2) * 26;
      const dy = Math.cos(T * 0.25 + i * 3) * 20;
      fileCard(ctx, x + dx + (x - W / 2) * k * 0.6, y + dy + (y - H / 2) * k * 0.6, 1.25, r, n, s);
    });
  });
  // the headlines: serif italic only
  const l1 = easeOutExpo(prog(t, 0.233, 1.0));
  ctx.save();
  ctx.font = F.serif(176);
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = l1;
  ctx.fillStyle = C.ink;
  ctx.fillText("Less uploading.", 200, 420 + (1 - l1) * 60);
  ctx.restore();
  const l2 = easeOutExpo(prog(t, 2.667, 3.4));
  ctx.save();
  ctx.font = F.serif(176);
  ctx.globalAlpha = l2;
  ctx.fillStyle = C.marigold;
  ctx.fillText("More tossing.", 200, 620 + (1 - l2) * 60);
  ctx.restore();
  // slow tosses
  tossCard(ctx, t, 0.667, 2.333, [240, 890, 1680, 850], 170, "trip.mp4", "4 GB");
  tossCard(ctx, t, 4.0, 5.633, [1680, 900, 250, 860], 150, "photos.zip", "1.2 GB");
  ctx.restore();
  if (k > 0) {
    // speed lines + warm wash into the cut
    ctx.save();
    ctx.translate(W / 2, H / 2);
    const r = rng(5);
    ctx.lineCap = "round";
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU;
      const r0 = lerp(260, 900, r()) * (0.6 + k);
      const len = 60 + 380 * k * r();
      ctx.strokeStyle = `rgba(232,163,23,${0.55 * k * (0.4 + r() * 0.6)})`;
      ctx.lineWidth = 2 + 4 * r();
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len));
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = `rgba(232,163,23,${0.3 * k})`;
    ctx.fillRect(0, 0, W, H);
  }
};

// =====================================================================
// 08 PHONES  66.67 - 74.67
// =====================================================================
const QN = 25;
const QR = (() => {
  const r = rng(2024);
  const finder = (x: number, y: number) => (x < 8 && y < 8) || (x > QN - 9 && y < 8) || (x < 8 && y > QN - 9);
  const fin: { x: number; y: number }[] = [];
  const data: { x: number; y: number; k: number }[] = [];
  for (let y = 0; y < QN; y++) {
    for (let x = 0; x < QN; x++) {
      if (finder(x, y)) {
        const fx = x < 8 ? x : x - (QN - 7);
        const fy = y < 8 ? y : y - (QN - 7);
        if (x === 7 || y === 7 || x === QN - 8 || y === QN - 8) continue;
        const ring = Math.max(Math.abs(fx - 3), Math.abs(fy - 3));
        if (ring === 3 || ring <= 1) fin.push({ x, y });
      } else if (r() < 0.5) data.push({ x, y, k: r() });
    }
  }
  data.sort((a, b) => a.k - b.k);
  return { fin, data };
})();

function drawQR(ctx: Ctx, size: number, u: number, color: string) {
  const m = size / QN;
  ctx.fillStyle = color;
  const finU = clamp(u / 0.18);
  const nF = Math.floor(finU * QR.fin.length);
  for (let i = 0; i < nF; i++) ctx.fillRect(-size / 2 + QR.fin[i].x * m, -size / 2 + QR.fin[i].y * m, m + 0.6, m + 0.6);
  const dU = clamp((u - 0.12) / 0.88);
  const nD = Math.floor(dU * QR.data.length);
  for (let i = 0; i < nD; i++) ctx.fillRect(-size / 2 + QR.data[i].x * m, -size / 2 + QR.data[i].y * m, m + 0.6, m + 0.6);
}

function tower(ctx: Ctx, x: number, yb: number, h: number, pulse: number, T: number) {
  ctx.save();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const hw = (f: number) => lerp(78, 9, f);
  ctx.beginPath();
  ctx.moveTo(x - 78, yb);
  ctx.lineTo(x - 9, yb - h);
  ctx.moveTo(x + 78, yb);
  ctx.lineTo(x + 9, yb - h);
  ctx.moveTo(x - 100, yb);
  ctx.lineTo(x + 100, yb);
  for (let i = 1; i <= 6; i++) {
    const f0 = (i - 1) / 6;
    const f1 = i / 6;
    const y0 = yb - h * f0;
    const y1 = yb - h * f1;
    ctx.moveTo(x - hw(f0), y0);
    ctx.lineTo(x + hw(f1), y1);
    ctx.moveTo(x + hw(f0), y0);
    ctx.lineTo(x - hw(f1), y1);
    ctx.moveTo(x - hw(f1), y1);
    ctx.lineTo(x + hw(f1), y1);
  }
  ctx.moveTo(x, yb - h);
  ctx.lineTo(x, yb - h - 60);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, yb - h - 66, 13, 0, TAU);
  ctx.fillStyle = C.marigold;
  ctx.fill();
  ctx.stroke();
  // radiating arcs at the tip
  for (let i = 0; i < 3; i++) {
    const ph = (T * 0.8 + i / 3) % 1;
    const a = (1 - ph) * 0.55 + pulse * 0.4;
    ctx.strokeStyle = `rgba(232,163,23,${Math.min(1, a)})`;
    ctx.lineWidth = 4;
    const r = 34 + ph * 50;
    ctx.beginPath();
    ctx.arc(x, yb - h - 66, r, -Math.PI * 0.8, -Math.PI * 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, yb - h - 66, r, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();
  }
  ctx.restore();
}

function laptop(ctx: Ctx, x: number, y: number, glow: number, got: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.roundRect(-170, -210, 340, 214, 16);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fill();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 4;
  ctx.stroke();
  if (glow > 0.01) {
    ctx.beginPath();
    ctx.roundRect(-170, -210, 340, 214, 16);
    ctx.fillStyle = `rgba(63,174,107,${0.28 * glow})`;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.roundRect(-214, 8, 428, 20, 10);
  ctx.fillStyle = C.ink;
  ctx.fill();
  // three slots, each filled as a sealed packet arrives
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.roundRect(-130, -176 + i * 52, 260, 38, 10);
    ctx.fillStyle = i < got ? "rgba(63,174,107,0.18)" : "rgba(19,20,25,0.06)";
    ctx.fill();
    if (i < got) {
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 3;
      ctx.stroke();
      check(ctx, 100, -157 + i * 52, 14, 1);
    }
    ctx.fillStyle = i < got ? C.ink : "rgba(19,20,25,0.18)";
    ctx.fillRect(-114, -162 + i * 52, 90 + i * 14, 8);
  }
  ctx.restore();
}

function packet(ctx: Ctx, x: number, y: number, s: number) {
  at(ctx, x, y, 0, s, () => {
    ctx.beginPath();
    ctx.roundRect(-32, -32, 64, 64, 14);
    ctx.fillStyle = C.marigold;
    ctx.shadowColor = "rgba(19,20,25,0.25)";
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    lock(ctx, 0, -2, 1, C.ink);
  });
}

const phones: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  ctx.save();
  drift(ctx, T, 8);
  headline(ctx, [{ text: "Phones too. " }, { text: "From anywhere.", italic: true }], 200, 300, 100, { reveal: easeOut(prog(t, 0.15, 1.0)) });
  ctx.globalAlpha = prog(t, 0.7, 1.2);
  mono(ctx, "pair once · the relay only sees sealed data", 204, 362, 28, C.ink);
  ctx.globalAlpha = 1;

  blurred(ctx, 14, () => {
    ctx.globalAlpha = 0.7;
    fileCard(ctx, 230 + Math.sin(T * 0.4) * 30, 560 - Math.cos(T * 0.3) * 20, 1.5, -0.2, "video.mov", "2 GB");
    fileCard(ctx, 1720 + Math.cos(T * 0.35) * 30, 480 + Math.sin(T * 0.3) * 20, 1.7, 0.22, "folder/", "340 files");
  });
  const PY = 700;
  const slide = easeInOut(prog(t, 3.7, 4.5));
  const phoneX = lerp(960, 470, slide);
  const show = easeOut(prog(t, 4.0, 4.7));

  // relay + laptop (fade in after the pairing)
  if (show > 0) {
    const pulses = [0, 1, 2].map((k) => hit(t, 4.667 + k + 0.475, 0.3));
    const pulse = Math.max(...pulses);
    ctx.save();
    ctx.globalAlpha = show;
    // the flow route
    ctx.save();
    ctx.setLineDash([16, 14]);
    ctx.lineDashOffset = -T * 60;
    ctx.strokeStyle = "rgba(19,20,25,0.35)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(phoneX + 170, PY + 30);
    ctx.lineTo(1300, PY + 30);
    ctx.stroke();
    ctx.restore();
    tower(ctx, 960, 900, 330, pulse, T);
    mono(ctx, "RELAY", 960, 950, 24, C.ink, "center");
    const arrive = [0, 1, 2].map((k) => hit(t, 4.667 + k + 0.95, 0.4));
    const got = [0, 1, 2].filter((k) => t >= 4.667 + k + 0.95).length;
    laptop(ctx, 1500 + (1 - show) * 200, 830, Math.max(...arrive), got);
    mono(ctx, "LAPTOP", 1500, 950, 24, C.ink, "center");
    ctx.restore();
    // sealed packets, phone -> relay -> laptop
    for (let k = 0; k < 3; k++) {
      const t0 = 4.667 + k;
      const p = prog(t, t0, t0 + 0.95);
      if (p <= 0 || p >= 1) continue;
      const x = lerp(phoneX + 180, 1340, p);
      const y = PY + 30 - 70 * Math.sin(p * Math.PI);
      ctx.globalAlpha = clamp(p * 8) * (1 - prog(p, 0.93, 1));
      packet(ctx, x, y, 0.9 + 0.25 * Math.sin(p * Math.PI));
      ctx.globalAlpha = 1;
    }
  }

  // the phone: thin glass outline
  at(ctx, phoneX, PY - 10, 0, 1, () => {
    const pw = 300;
    const ph = 540;
    ctx.save();
    ctx.shadowColor = "rgba(19,20,25,0.15)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    ctx.beginPath();
    ctx.roundRect(-pw / 2, -ph / 2, pw, ph, 48);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(-pw / 2, -ph / 2, pw, ph, 48);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-pw / 2 + 14, -ph / 2 + 14, pw - 28, ph - 28, 36);
    ctx.strokeStyle = "rgba(19,20,25,0.18)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-46, -ph / 2 + 26, 92, 24, 12);
    ctx.fillStyle = C.ink;
    ctx.fill();
    // QR builds module by module
    const qu = prog(t, 0.667, 2.133);
    const paired = prog(t, 3.533, 4.0);
    ctx.save();
    ctx.translate(0, -24);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.roundRect(-128, -128, 256, 256, 18);
    ctx.fill();
    ctx.globalAlpha = 1 - 0.85 * paired;
    drawQR(ctx, 216, qu, C.ink);
    ctx.globalAlpha = 1;
    // scan light, clipped to the code
    const sw = prog(t, 2.667, 3.3);
    if (sw > 0 && sw < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-128, -128, 256, 256, 18);
      ctx.clip();
      const y = lerp(-140, 140, easeInOut(sw));
      const g = ctx.createLinearGradient(0, y - 60, 0, y + 6);
      g.addColorStop(0, "rgba(63,174,107,0)");
      g.addColorStop(1, "rgba(63,174,107,0.55)");
      ctx.fillStyle = g;
      ctx.fillRect(-128, y - 60, 256, 66);
      ctx.fillStyle = C.green;
      ctx.fillRect(-128, y, 256, 5);
      ctx.restore();
    }
    // corner brackets of the viewfinder
    ctx.strokeStyle = C.marigold;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    const br = 146;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx * br, sy * (br - 34));
      ctx.lineTo(sx * br, sy * br);
      ctx.lineTo(sx * (br - 34), sy * br);
      ctx.stroke();
    }
    ctx.restore();
    if (paired > 0) {
      check(ctx, 0, -24, 76, paired);
      const b = prog(t, 3.533, 4.2);
      if (b < 1) {
        ctx.strokeStyle = `rgba(63,174,107,${0.8 * (1 - b)})`;
        ctx.lineWidth = 8 * (1 - b) + 1;
        ctx.beginPath();
        ctx.arc(0, -24, 76 + 200 * easeOutExpo(b), 0, TAU);
        ctx.stroke();
      }
    }
    ctx.font = F.mono(24, 700);
    ctx.textAlign = "center";
    ctx.fillStyle = paired > 0.5 ? C.green : C.muted;
    ctx.fillText(paired > 0.5 ? "PAIRED" : "SCAN TO PAIR", 0, 190);
  });
  ctx.restore();
};

// =====================================================================
// 09 EVERYTHING  74.67 - 80
// =====================================================================
const STK_COLORS: [string, string][] = [
  [C.marigold, C.ink], [C.white, C.ink], [C.ink, C.inkText], [C.green, C.white], [C.sky, C.ink],
  [C.vermilion, C.white], [C.peach, C.ink], [C.white, C.ink], [C.ink, C.marigoldSoft], [C.marigoldSoft, C.ink],
];
const STK_ANGLE = [-90, -18, 160, 50, -132, 128, -52, 20, 100, -166];
const stickerRot = (() => {
  const r = rng(77);
  return STK_ANGLE.map(() => (r() - 0.5) * 0.3);
})();

const everything: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  const CX = 960;
  const CY = 610;
  ctx.save();
  drift(ctx, T, 9);
  // guide ellipse the stickers orbit on
  ctx.save();
  ctx.setLineDash([10, 14]);
  ctx.lineDashOffset = -T * 20;
  ctx.strokeStyle = "rgba(19,20,25,0.22)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(CX, CY, 640, 270, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();

  // headline
  headline(ctx, [{ text: "Everything you need, " }, { text: "one toss away.", italic: true }], 200, 250, 72, { reveal: easeOut(prog(t, 0.1, 0.9)) });

  // icon with a tiny kick at every sticker
  const kick = Math.max(0, ...timeline.stickerTimes.map((s) => hit(T, s, 0.2)));
  const iconIn = easeOutBack(prog(t, 0, 0.45));
  yonIcon(ctx, CX, CY, 250 * iconIn * (1 + 0.05 * kick));

  // stickers
  let n = 0;
  let last = -1;
  timeline.stickerTimes.forEach((st, i) => {
    const u = T - st;
    if (u < 0) return;
    n++;
    last = i;
    const a = (STK_ANGLE[i] * Math.PI) / 180;
    const x = CX + Math.cos(a) * 640;
    const y = CY + Math.sin(a) * 270;
    const e = easeOutBack(prog(u, 0, 0.22), 2.4);
    const s = lerp(2.3, 1, e);
    const shake = Math.sin(u * 70) * 0.07 * hit(u, 0, 0.22);
    const [bg, fg] = STK_COLORS[i];
    ctx.save();
    ctx.globalAlpha = clamp(u * 25);
    at(ctx, x, y, stickerRot[i] + shake, s, () => {
      ctx.shadowColor = "rgba(19,20,25,0.28)";
      ctx.shadowBlur = lerp(50, 16, e);
      ctx.shadowOffsetY = lerp(30, 8, e);
      pill(ctx, timeline.stickers[i], 0, 0, F.grotesk(32, 900), fg, bg, 34, 72, i === 7 ? C.marigold : undefined);
    });
    ctx.restore();
    // impact burst
    const b = prog(u, 0, 0.3);
    if (b > 0 && b < 1) {
      ctx.strokeStyle = `rgba(232,163,23,${1 - b})`;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * TAU + i;
        const r0 = 130 + 50 * b;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(ang) * r0 * 1.4, y + Math.sin(ang) * r0 * 0.7);
        ctx.lineTo(x + Math.cos(ang) * (r0 + 34) * 1.4, y + Math.sin(ang) * (r0 + 34) * 0.7);
        ctx.stroke();
      }
    }
  });

  // counter, top right of the content area
  const cp = last >= 0 ? 1 + 0.25 * hit(T, timeline.stickerTimes[last], 0.16) : 1;
  at(ctx, 1770, 250, 0, cp, () => {
    ctx.textAlign = "right";
    ctx.font = F.grotesk(84, 900);
    ctx.fillStyle = n === 10 ? C.marigold : C.ink;
    ctx.fillText(String(n).padStart(2, "0"), 0, 0);
    ctx.font = F.mono(28, 700);
    ctx.fillStyle = C.muted;
    ctx.fillText("/10", 84, 0);
  });
  ctx.restore();
};

// =====================================================================
// 10 OPEN  80 - 85.33
// =====================================================================
const open: Scene = (ctx, t, T) => {
  ctx.fillStyle = C.marigold;
  ctx.fillRect(0, 0, W, H);
  const second = t >= 2.667;
  const tt = second ? t - 2.667 : t;
  const z = 1 + 0.03 * prog(tt, 0, 2.67);
  ctx.save();
  ctx.translate(W / 2, H / 2 + Math.sin(T * 0.7) * 5);
  ctx.scale(z, z);
  ctx.translate(-W / 2, -H / 2);
  const u = easeOutExpo(prog(tt, 0, 0.45));
  if (!second) {
    // ghost code-ish lines behind the headline
    ctx.fillStyle = "rgba(19,20,25,0.1)";
    const r = rng(3);
    for (let i = 0; i < 7; i++) {
      const w = 300 + r() * 700;
      ctx.fillRect(1920 - w - 100 + (1 - u) * 400, 170 + i * 42, w, 14);
    }
    headline(ctx, [{ text: "Read every " }, { text: "line.", italic: true }], 160, 590 + (1 - u) * 80, 172, { reveal: u, color: C.ink });
    ctx.fillStyle = C.ink;
    ctx.fillRect(160, 690, 1600 * easeOut(prog(tt, 0.2, 0.9)), 4);
    ctx.globalAlpha = prog(tt, 0.4, 0.8);
    mono(ctx, "MIT licensed · github.com/VacTuzX-dot/Yon", 160, 760, 36, C.ink);
    ctx.globalAlpha = 1;
  } else {
    // terminal dots in the back
    ctx.strokeStyle = "rgba(19,20,25,0.12)";
    ctx.lineWidth = 3;
    for (let i = 1; i <= 5; i++) {
      ctx.beginPath();
      ctx.arc(1620, 330, i * 95 + hit(tt, 0, 0.5) * 30, 0, TAU);
      ctx.stroke();
    }
    headline(ctx, [{ text: "Run your own " }, { text: "relay.", italic: true }], 160, 500 + (1 - u) * 80, 150, { reveal: u, color: C.ink });
    ctx.fillStyle = C.ink;
    ctx.fillRect(160, 580, 1600 * easeOut(prog(tt, 0.2, 0.9)), 4);
    // terminal strip
    const ts = easeOutExpo(prog(tt, 0.3, 0.8));
    ctx.save();
    ctx.translate(0, (1 - ts) * 160);
    ctx.globalAlpha = ts;
    ctx.shadowColor = "rgba(19,20,25,0.3)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    ctx.beginPath();
    ctx.roundRect(160, 680, 1600, 190, 26);
    ctx.fillStyle = C.ink;
    ctx.fill();
    ctx.shadowColor = "transparent";
    [C.vermilion, C.marigold, C.green].forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(208 + i * 34, 724, 10, 0, TAU);
      ctx.fillStyle = c;
      ctx.fill();
    });
    mono(ctx, "relay", 1720, 730, 22, "rgba(236,232,223,0.5)", "right");
    const tu = prog(t, 3.6, 4.8);
    const str = "$ docker compose up";
    const caretOn = tu >= 1 ? Math.floor(T * 2) % 2 === 0 : true;
    ctx.font = F.mono(56, 600);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.inkText;
    const shown = typed(str, tu, false);
    ctx.fillText(shown, 208, 820);
    if (shown.length > 0 && shown.startsWith("$")) {
      // colour the prompt marigold
      ctx.fillStyle = C.marigold;
      ctx.fillText("$", 208, 820);
    }
    if (caretOn) {
      const cw = ctx.measureText(shown).width;
      ctx.fillStyle = C.marigold;
      ctx.fillRect(208 + cw + 6, 776, 26, 52);
    }
    ctx.restore();
  }
  ctx.restore();
};

// =====================================================================
// OUTRO  85.33 - 90
// =====================================================================
function ring3d(ctx: Ctx, cx: number, cy: number, R: number, theta: number, tube: number, alpha: number) {
  if (alpha <= 0 || R <= 1) return;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const rx = Math.max(Math.abs(cosT) * R, 4);
  const N = 14;
  const depth = 0.3 * R;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy);
  ctx.rotate(-0.28);
  // contact shadow
  ctx.save();
  ctx.shadowColor = "rgba(19,20,25,0.32)";
  ctx.shadowBlur = 50;
  ctx.shadowOffsetY = 34;
  ctx.strokeStyle = "rgba(200,196,186,1)";
  ctx.lineWidth = tube;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, R, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
  for (let k = 0; k < N; k++) {
    const f = k / (N - 1);
    const off = (f - 0.5) * depth * sinT;
    const sh = sinT >= 0 ? f : 1 - f;
    const r = Math.round(lerp(186, 255, sh));
    const g = Math.round(lerp(181, 255, sh));
    const b = Math.round(lerp(170, 253, sh));
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = tube;
    ctx.beginPath();
    ctx.ellipse(off, 0, rx, R, 0, 0, TAU);
    ctx.stroke();
  }
  // specular rim + inner shade so it reads as a solid tube
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = tube * 0.22;
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(rx - tube * 0.22, 2), R - tube * 0.22, 0, Math.PI * 0.95, Math.PI * 1.75);
  ctx.stroke();
  ctx.strokeStyle = "rgba(19,20,25,0.1)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(rx - tube / 2, 2), R - tube / 2, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

const SPARKS: [number, number, number, number][] = [
  [520, 400, 18, 0], [1400, 330, 14, 1.3], [1500, 640, 20, 2.1], [440, 720, 12, 0.7], [1440, 800, 16, 1.9],
];

const outro: Scene = (ctx, t, T) => {
  paperBg(ctx, T);
  const landed = prog(t, 2.0, 2.6); // the logo lands at 87.333
  ctx.save();
  drift(ctx, T, 5);

  // ring whooshes in, spinning, then collapses
  const spin = easeOut(prog(t, 0, 1.333));
  const coll = easeIn(prog(t, 1.333, 1.9));
  if (t < 1.95) {
    const rad = lerp(300, 100, coll);
    const sc = lerp(2.6, 1, easeOutExpo(prog(t, 0, 1.0)));
    const px = lerp(1500, 960, easeOutExpo(prog(t, 0, 1.2)));
    const py = lerp(260, 540, easeOutExpo(prog(t, 0, 1.2)));
    blurred(ctx, (1 - easeOutExpo(prog(t, 0, 1.0))) * 16 + coll * 4, () => {
      ring3d(ctx, px, py, rad * sc, 0.5 + spin * TAU * 3.5, lerp(56, 84, coll) * sc, 1 - prog(t, 1.85, 1.95));
    });
  }
  // the icon appears as the ring shrinks into it, then moves up to the stack
  const iconIn = easeOutBack(prog(t, 1.45, 1.9), 2);
  const move = easeOutExpo(prog(t, 2.0, 2.6));
  const iconSize = lerp(230, 124, move);
  const iy = lerp(540, 252, move);
  if (t >= 1.45) yonIcon(ctx, 960, iy, iconSize * iconIn * (1 + 0.06 * hit(t, 1.9, 0.3)), 1, "arc");

  if (landed > 0) {
    const a = 1 + 0.004 * Math.sin(T * 1.4);
    ctx.save();
    ctx.translate(0, Math.sin(T * 1.1) * 3);
    // small Thai word above the wordmark
    const tu = easeOutExpo(prog(t, 2.0, 2.45));
    ctx.globalAlpha = tu;
    thai(ctx, "โยน", 960, 392 - (1 - tu) * 30, 50, C.ink, "center", 700);
    // YON wordmark, big, gradient fill over an ink outline
    const wu = easeOutBack(prog(t, 2.0, 2.4), 2);
    ctx.globalAlpha = clamp(prog(t, 2.0, 2.06));
    ctx.save();
    ctx.translate(960, 660);
    ctx.scale(lerp(1.5, 1, wu) * a, lerp(1.5, 1, wu) * a);
    ctx.font = F.grotesk(310, 900);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const tw = ctx.measureText("YON").width;
    const sh = Math.sin(T * 0.6) * 40;
    const g = ctx.createLinearGradient(-tw / 2 + sh, 0, tw / 2 + sh, 0);
    g.addColorStop(0, C.marigold);
    g.addColorStop(0.55, C.peach);
    g.addColorStop(1, C.sky);
    ctx.lineJoin = "round";
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 16;
    ctx.strokeText("YON", 0, 0);
    // hard offset shadow, sticker style
    ctx.fillStyle = C.ink;
    ctx.fillText("YON", 10, 12);
    ctx.fillStyle = g;
    ctx.fillText("YON", 0, 0);
    ctx.restore();
    // tagline, domain, install chip, staggered
    const l1 = easeOutExpo(prog(t, 2.25, 2.75));
    ctx.globalAlpha = l1;
    ctx.save();
    ctx.font = F.mono(30, 600);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "center";
    if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = "7px";
    ctx.fillText("TOSS FILES TO NEARBY DEVICES", 960 + 3, 742 + (1 - l1) * 24);
    ctx.restore();
    const l2 = easeOutExpo(prog(t, 2.4, 2.9));
    ctx.globalAlpha = l2;
    mono(ctx, "YON.MEO.IN.TH", 960, 806 + (1 - l2) * 24, 34, C.ink, "center");
    const l3 = easeOutBack(prog(t, 2.55, 3.05));
    ctx.globalAlpha = clamp(l3);
    at(ctx, 960, 884, 0, lerp(0.85, 1, l3), () => {
      ctx.font = F.mono(28, 600);
      const s = "$ curl -fsSL yon.meo.in.th/mac | bash";
      const w = ctx.measureText(s).width + 64;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -34, w, 68, 18);
      ctx.fillStyle = C.ink;
      ctx.shadowColor = "rgba(19,20,25,0.3)";
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.marigold;
      ctx.fillText("$", -w / 2 + 32, 2);
      const dw = ctx.measureText("$ ").width;
      ctx.fillStyle = C.inkText;
      ctx.fillText(s.slice(2), -w / 2 + 32 + dw, 2);
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    // shock ring at the landing + twinkling sparkles
    const sr = prog(t, 2.0, 2.7);
    if (sr > 0 && sr < 1) {
      ctx.strokeStyle = `rgba(232,163,23,${0.8 * (1 - sr)})`;
      ctx.lineWidth = 10 * (1 - sr) + 1;
      ctx.beginPath();
      ctx.ellipse(960, 560, 200 + 900 * easeOutExpo(sr), 120 + 560 * easeOutExpo(sr), 0, 0, TAU);
      ctx.stroke();
    }
    for (const [x, y, r, ph] of SPARKS) {
      const tw2 = 0.5 + 0.5 * Math.sin(T * 2.2 + ph * 3);
      sparkle(ctx, x, y + Math.sin(T * 0.8 + ph) * 6, r * (0.6 + 0.6 * tw2), C.vermilion, landed * (0.35 + 0.65 * tw2));
    }
  }
  ctx.restore();
  // a soft white flash on the chord
  const fl = hit(t, 2.0, 0.14);
  if (fl > 0.02) {
    ctx.fillStyle = `rgba(255,255,255,${(0.5 * fl).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
};

export const scenesB: Record<string, Scene> = { checked, zero, anysize, breather, phones, everything, open, outro };
