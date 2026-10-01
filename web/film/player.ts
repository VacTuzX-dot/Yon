// The page around a film: the full-screen player, or (with ?render) the frame
// renderer scripts/render-film.ts drives. Shared by the voxel film (web/film/)
// and the editorial reel (web/reel/); each passes its own createFilm.
export interface Film {
  render(t: number): void;
  resize(w: number, h: number): void;
  duration: number;
}
export type CreateFilm = (glCanvas: HTMLCanvasElement, capCanvas: HTMLCanvasElement, opts?: { preserve?: boolean }) => Film;
export interface Timeline {
  width: number;
  height: number;
  poster: number;
}

declare global {
  interface Window {
    filmReady?: Promise<void>;
    filmRenderFrame?: (t: number) => Promise<Blob>;
    YON_FILM_RENDER?: boolean;
  }
}

function renderMode(createFilm: CreateFilm, W: number, H: number) {
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
function playerMode(root: HTMLElement, createFilm: CreateFilm, W: number, H: number, poster: number) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const glC = $<HTMLCanvasElement>("canvas.film-gl");
  const capC = $<HTMLCanvasElement>("canvas.film-cap");
  const frame = $(".frame");
  const seek = $<HTMLInputElement>("input.film-seek");
  const clock = $(".film-time");
  const left = $(".film-left");
  const playBtn = $<HTMLButtonElement>("button.film-play");
  const soundBtn = $<HTMLButtonElement>("button.film-sound");
  const volEl = $<HTMLInputElement>("input.film-vol");
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
  // film.mp3 sits next to the page: the soundtrack WAV encoded for the web.
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

  // Volume: remembered between visits. iOS ignores audio.volume (it stays at 1),
  // so there the slider is hidden and only the mute button is left.
  let vol = 1;
  try {
    const v = Number(localStorage.getItem("yon-film-volume"));
    if (v >= 0 && v <= 1 && localStorage.getItem("yon-film-volume") !== null) vol = v;
  } catch {}
  let lastVol = vol > 0 ? vol : 0.6; // what un-muting from 0 goes back to
  audio.volume = 0.5;
  if (audio.volume !== 0.5) root.classList.add("no-vol");
  const applyVol = () => {
    audio.volume = vol;
    volEl.value = String(vol);
    volEl.style.setProperty("--fill", `${Math.round(vol * 100)}%`);
    volEl.setAttribute("aria-valuetext", `${Math.round(vol * 100)}%`);
    root.classList.toggle("vol-low", vol > 0 && vol < 0.5);
  };
  const setVol = (v: number) => {
    vol = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
    if (vol > 0) lastVol = vol;
    applyVol();
    try {
      localStorage.setItem("yon-film-volume", String(vol));
    } catch {}
    // Raising the volume is asking for sound.
    if (vol > 0 && running && (!wantSound || !audioOn())) {
      wantSound = true;
      void playSound();
    }
    sync();
  };
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const show = () => {
    film.render(t);
    seek.value = String(t);
    clock.textContent = mmss(t);
    left.textContent = `-${mmss(Math.max(0, film.duration - t))}`;
    seek.style.setProperty("--fill", `${((t / film.duration) * 100).toFixed(2)}%`);
    seek.setAttribute("aria-valuetext", `${mmss(t)} of ${mmss(film.duration)}`);
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
    root.classList.toggle("muted", !wantSound || vol === 0);
    root.classList.toggle("ended", ended);
    end.hidden = !ended;
    playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
    soundBtn.setAttribute("aria-label", wantSound && !soundBlocked && vol > 0 ? "Mute" : "Sound on");
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
  // Mute / un-mute; un-muting from volume 0 goes back to the last level.
  const toggleMute = () => {
    if (vol === 0) {
      vol = lastVol;
      applyVol();
      setSound(true);
      sync();
    } else setSound(!(wantSound && audioOn()));
  };
  soundBtn.addEventListener("click", toggleMute);
  volEl.addEventListener("input", () => setVol(Number(volEl.value)));
  applyVol();
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
    } else if (e.key === "m") toggleMute();
    else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && tag !== "INPUT") {
      e.preventDefault();
      setVol(vol + (e.key === "ArrowUp" ? 0.1 : -0.1));
    }
    else if (e.key === "f" && document.fullscreenEnabled) fullBtn.click();
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && tag !== "INPUT" && !ended) {
      t = Math.max(0, Math.min(film.duration - 0.1, t + (e.key === "ArrowLeft" ? -5 : 5)));
      if (audioOn()) audio.currentTime = t;
      show();
    }
  });

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Poster: the logo in the sky. The visitor starts it.
    t = poster;
    show();
    root.classList.add("gate");
    root.classList.remove("hint");
    sync();
  } else {
    void begin();
  }
}

export function boot(createFilm: CreateFilm, timeline: Timeline) {
  const { width: W, height: H } = timeline;
  if (window.YON_FILM_RENDER || new URLSearchParams(location.search).has("render")) {
    renderMode(createFilm, W, H);
  } else {
    const root = document.querySelector<HTMLElement>(".film");
    if (root) playerMode(root, createFilm, W, H, timeline.poster);
  }
}
