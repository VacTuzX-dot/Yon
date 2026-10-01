// "Yon in 90 seconds, editorial cut": a 90 s motion-design reel drawn with
// the 2D canvas. Same contract as the voxel film (web/film/): every frame is a
// pure function of time, the shared player (../film/player.ts) plays it with
// the soundtrack as the clock, and scripts/render-film.ts (FILM=web/reel)
// renders it to MP4. Scenes live in scenes-a.ts (0-48 s) and scenes-b.ts
// (48-90 s); the HUD, cuts and flashes are here. Music: scripts/reel_music.py.
import timeline from "./timeline.json";
import { boot, type Film } from "../film/player";
import { C, F, H, W, clamp, hit, prog, type Ctx, type Scene } from "./kit";
import { scenesA } from "./scenes-a";
import { scenesB } from "./scenes-b";

const SCENES: Record<string, Scene> = { ...scenesA, ...scenesB };
const FLASH = timeline.cues.filter((c) => c.kind === "impact" || c.kind === "drop" || c.kind === "slam").map((c) => c.t);

/** The four-corner HUD: brand, chapter + progress, figure caption, domain. */
function hud(ctx: Ctx, T: number, s: (typeof timeline.scenes)[number]) {
  const dark = "dark" in s && s.dark;
  const fg = dark ? C.inkText : C.ink;
  const dim = dark ? "rgba(236,232,223,0.55)" : "rgba(19,20,25,0.5)";
  // Fade in after the cold open's first bars, out under the final logo.
  const a = clamp(prog(T, 1.5, 3)) * (1 - prog(T, 87.3, 88.3));
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textBaseline = "alphabetic";
  ctx.font = F.grotesk(26, 900);
  ctx.fillStyle = fg;
  ctx.fillText("YON", 64, 78);
  ctx.font = F.thai(20, 600);
  ctx.fillText("โยน", 132, 78);
  ctx.font = F.mono(16);
  ctx.fillStyle = dim;
  ctx.fillText("FILE TRANSFER / v0.2.4", 64, 104);
  ctx.textAlign = "right";
  if (s.chapter) {
    ctx.font = F.mono(18, 600);
    ctx.fillStyle = fg;
    ctx.fillText(s.chapter, W - 64, 78);
  }
  ctx.fillStyle = dim;
  ctx.fillRect(W - 264, 96, 200, 2);
  ctx.fillStyle = dark ? C.marigoldSoft : C.marigold;
  ctx.fillRect(W - 264, 95, 200 * (T / timeline.duration), 4);
  ctx.font = F.mono(16, 600);
  ctx.fillStyle = fg;
  ctx.fillText("YON.MEO.IN.TH", W - 64, H - 60);
  ctx.textAlign = "left";
  ctx.font = /[฀-๿]/.test(s.fig) ? F.thai(18, 500) : F.mono(16);
  ctx.fillStyle = dim;
  ctx.fillText(s.fig, 64, H - 60);
  // corner ticks
  ctx.strokeStyle = dim;
  ctx.lineWidth = 2;
  for (const [x, y, dx, dy] of [[40, 40, 1, 1], [W - 40, 40, -1, 1], [40, H - 40, 1, -1], [W - 40, H - 40, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + 22 * dy);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 22 * dx, y);
    ctx.stroke();
  }
  ctx.restore();
}

function createFilm(_gl: HTMLCanvasElement, cap: HTMLCanvasElement): Film {
  const ctx = cap.getContext("2d")!;
  let scale = 1;
  const resize = (w: number, h: number) => {
    cap.width = w;
    cap.height = h;
    scale = w / W;
  };
  resize(cap.width || W, cap.height || H);
  const render = (T: number) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    const s = timeline.scenes.find((x) => T < x.end) ?? timeline.scenes[timeline.scenes.length - 1];
    SCENES[s.id]?.(ctx, T - s.start, T);
    hud(ctx, T, s);
    // A two-frame flash on the big hits, so cuts land on the beat.
    const f = Math.max(0, ...FLASH.map((c) => hit(T, c, 0.12)));
    if (f > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${(0.55 * f).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    // Fade to paper at the very end.
    const out = prog(T, 89.2, 90);
    if (out > 0) {
      ctx.fillStyle = `rgba(243,241,236,${out.toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
  };
  return { render, resize, duration: timeline.duration };
}

boot(createFilm, timeline);
