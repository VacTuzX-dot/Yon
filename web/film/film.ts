// "Yon: the other computer is right there", a 90 s WebGL film. Every frame
// is a pure function of time, so the page can play it live (the soundtrack's
// clock drives it) and scripts/render-film.ts can render the same frames into
// an MP4.
//
// A voxel world drawn at low resolution through a pixel-art pass (engine.ts),
// built once from code (world.ts); the story, the camera and everything that
// moves (story.ts); chat, thoughts, captions and the Accept dialog as a pixel
// 2D layer on top (overlay.ts). Plain WebGL, no library: this origin runs no
// third-party code. The music is scripts/film_music.py (algorithmic, Python).
import timeline from "./timeline.json";
import { createEngine, meshVoxels, project } from "./engine";
import { drawOverlay } from "./overlay";
import { shot } from "./story";
import { buildWorld, PAL } from "./world";

const W = timeline.width;
const H = timeline.height;
/** The pixel buffer: every "pixel" of the film is 3x3 at 1080p. */
const LOW: [number, number] = [640, 360];

interface Film {
  render(t: number): void;
  resize(w: number, h: number): void;
  duration: number;
  captions: HTMLCanvasElement;
  gl: HTMLCanvasElement;
}

function createFilm(glCanvas: HTMLCanvasElement, capCanvas: HTMLCanvasElement, opts: { preserve?: boolean } = {}): Film {
  const engine = createEngine(glCanvas, meshVoxels(buildWorld(), PAL), LOW, !!opts.preserve);
  const ctx = capCanvas.getContext("2d")!;
  let scale = 1;
  const resize = (w: number, h: number) => {
    engine.resize(w, h);
    capCanvas.width = w;
    capCanvas.height = h;
    scale = w / W;
  };
  resize(glCanvas.width || W, glCanvas.height || H);
  const render = (t: number) => {
    const s = shot(t, timeline.duration);
    const vp = engine.draw(s.frame);
    drawOverlay(ctx, t, scale, {
      head: s.head && project(vp, s.head, W, H),
      pcScreen: s.pcScreen && project(vp, s.pcScreen, W, H),
    });
  };
  return { render, resize, duration: timeline.duration, captions: capCanvas, gl: glCanvas };
}

// ---------- the page: player, or frame renderer for the MP4 ----------

declare global {
  interface Window {
    filmReady?: Promise<void>;
    filmRenderFrame?: (t: number) => Promise<Blob>;
    YON_FILM_RENDER?: boolean;
  }
}

function renderMode() {
  const gl = document.createElement("canvas");
  const cap = document.createElement("canvas");
  gl.width = cap.width = W;
  gl.height = cap.height = H;
  const film = createFilm(gl, cap, { preserve: true });
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const o = out.getContext("2d")!;
  window.filmRenderFrame = (t: number) => {
    film.render(t);
    o.drawImage(gl, 0, 0);
    o.drawImage(cap, 0, 0);
    return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
  };
  window.filmReady = document.fonts ? document.fonts.ready.then(() => undefined) : Promise.resolve();
}

// The player: fills the screen and starts by itself. If the browser won't
// play sound without a tap, the picture still runs and a "Tap for sound"
// button asks for that tap. With reduced motion nothing starts on its own.
function playerMode(root: HTMLElement) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const glC = $<HTMLCanvasElement>("canvas.film-gl");
  const capC = $<HTMLCanvasElement>("canvas.film-cap");
  const frame = $(".frame");
  const seek = $<HTMLInputElement>("input.film-seek");
  const clock = $(".film-time");
  const playBtn = $<HTMLButtonElement>("button.film-play");
  const soundBtn = $<HTMLButtonElement>("button.film-sound");
  const pill = $<HTMLButtonElement>("button.sound-pill");
  const fullBtn = $<HTMLButtonElement>("button.film-full");
  const startBtn = $<HTMLButtonElement>("button.film-start");
  const again = $<HTMLButtonElement>("button.film-again");
  const end = $(".end");
  let film: Film;
  try {
    film = createFilm(glC, capC);
  } catch {
    root.classList.add("no-gl");
    return;
  }
  // film.mp3 is film.wav (scripts/film_music.py) encoded for the web.
  const audio = new Audio("film.mp3");
  audio.preload = "auto";

  let t = 0; // seconds into the film
  let running = false; // the picture is moving
  let ended = false;
  let wantSound = true; // false once the visitor mutes
  let soundBlocked = false; // the browser refused to start the sound
  let last = 0;
  let raf = 0;
  const audioOn = () => !audio.paused;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const show = () => {
    film.render(t);
    seek.value = String(t);
    clock.textContent = `${mmss(t)} / ${mmss(film.duration)}`;
  };
  seek.max = String(film.duration);
  const fit = () => {
    const w = Math.min(2560, Math.round(frame.getBoundingClientRect().width * Math.min(devicePixelRatio || 1, 2)));
    film.resize(w, Math.round((w * H) / W));
    show();
  };
  fit();
  new ResizeObserver(fit).observe(frame);

  const sync = () => {
    root.classList.toggle("playing", running);
    root.classList.toggle("no-sound", running && wantSound && soundBlocked && !audioOn());
    root.classList.toggle("muted", !wantSound);
    root.classList.toggle("ended", ended);
    end.hidden = !ended;
    playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
    soundBtn.setAttribute("aria-label", wantSound && !soundBlocked ? "Mute" : "Sound on");
  };

  // Controls fade out while it plays; any movement or key brings them back.
  let idleTimer = 0;
  const wake = () => {
    root.classList.remove("idle");
    clearTimeout(idleTimer);
    if (running) idleTimer = window.setTimeout(() => root.classList.add("idle"), 2500);
  };
  for (const ev of ["pointermove", "pointerdown", "keydown", "touchstart"]) addEventListener(ev, wake, { passive: true });

  const frameLoop = (now: number) => {
    raf = 0;
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    // The sound is the clock while it plays; otherwise a wall clock.
    t = audioOn() ? audio.currentTime : t + dt;
    if (t >= film.duration) return finish();
    show();
    raf = requestAnimationFrame(frameLoop);
  };
  const run = () => {
    running = true;
    last = performance.now();
    sync();
    wake();
    if (!raf) raf = requestAnimationFrame(frameLoop);
  };
  const playSound = async () => {
    if (!wantSound) return;
    audio.currentTime = t;
    try {
      await audio.play();
      soundBlocked = false;
    } catch {
      soundBlocked = true;
    }
    sync();
  };
  const finish = () => {
    running = false;
    ended = true;
    audio.pause();
    t = film.duration - 0.01;
    show();
    sync();
    wake();
    root.querySelector<HTMLElement>(".end .primary")?.focus();
  };
  const pause = () => {
    running = false;
    audio.pause();
    sync();
    wake();
  };
  const begin = async (from = 0) => {
    t = from;
    ended = false;
    root.classList.remove("gate");
    show();
    running = true;
    sync();
    // Wait briefly for the sound so picture and music start together.
    await Promise.race([playSound(), new Promise((r) => setTimeout(r, 1200))]);
    if (running) run();
    setTimeout(() => root.classList.remove("hint"), 5000);
  };
  const toggle = () => {
    if (ended) return void begin();
    if (running) pause();
    else {
      run();
      void playSound();
    }
  };
  const setSound = (on: boolean) => {
    wantSound = on;
    if (on) void playSound();
    else {
      audio.pause();
      sync();
    }
  };

  playBtn.addEventListener("click", toggle);
  again.addEventListener("click", () => void begin());
  startBtn.addEventListener("click", () => void begin());
  pill.addEventListener("click", () => {
    wantSound = true;
    void playSound();
  });
  soundBtn.addEventListener("click", () => setSound(!(wantSound && audioOn())));
  // A tap on the picture asks for sound if it is missing, otherwise pauses.
  frame.addEventListener("click", () => {
    if (ended || root.classList.contains("gate")) return;
    if (running && wantSound && soundBlocked && !audioOn()) void playSound();
    else toggle();
  });
  seek.addEventListener("input", () => {
    t = Number(seek.value);
    if (audioOn()) audio.currentTime = t;
    if (ended) {
      ended = false;
      run();
      void playSound();
    }
    show();
  });
  if (document.fullscreenEnabled) {
    fullBtn.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void root.requestFullscreen();
    });
  } else fullBtn.hidden = true;
  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === " " && tag !== "BUTTON" && tag !== "A" && tag !== "INPUT") {
      e.preventDefault();
      toggle();
    } else if (e.key === "m") setSound(!(wantSound && audioOn()));
    else if (e.key === "f" && document.fullscreenEnabled) fullBtn.click();
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && tag !== "INPUT" && !ended) {
      t = Math.max(0, Math.min(film.duration - 0.1, t + (e.key === "ArrowLeft" ? -5 : 5)));
      if (audioOn()) audio.currentTime = t;
      show();
    }
  });

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Poster: the logo in the sky. The visitor starts it.
    t = timeline.poster;
    show();
    root.classList.add("gate");
    root.classList.remove("hint");
    sync();
  } else {
    void begin();
  }
}

if (window.YON_FILM_RENDER || new URLSearchParams(location.search).has("render")) {
  renderMode();
} else {
  const root = document.querySelector<HTMLElement>(".film");
  if (root) playerMode(root);
}
