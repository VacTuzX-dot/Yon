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
import { boot, type Film } from "./player";

const W = timeline.width;
const H = timeline.height;
/** The pixel buffer: every "pixel" of the film is 3x3 at 1080p. */
const LOW: [number, number] = [640, 360];

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
  return { render, resize, duration: timeline.duration };
}

boot(createFilm, timeline);
