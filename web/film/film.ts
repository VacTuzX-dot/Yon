// "Yon in 72 seconds": a WebGL film. Every frame is a pure function of time,
// so the page can play it live (the soundtrack's clock drives it) and
// scripts/render-film.ts can render the same frames into an MP4.
//
// One visual language throughout: ~6,000 particles that move between
// "formations" (the logo, devices around you, a file, a folder, a phone and
// a QR code). A transition can fly along an arc, which is how a file is
// tossed: its particles leave as sealed chunks and land as the same file.
// Plain WebGL, no library: this origin runs no third-party code.
import timeline from "./timeline.json";

type Scene = (typeof timeline.scenes)[number];

const W = timeline.width;
const H = timeline.height;
const N = 12000;
const PAYLOAD = 1800; // particles [0, PAYLOAD) are "the file": they travel

// ---------- formations ----------

/** Per particle: x, y, color (0 ink … 1 marigold), alpha. */
type Formation = Float32Array; // N * 4

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

type Pt = [number, number];

/** Points along a closed/open polyline, evenly by length. */
function alongPath(path: Pt[], n: number, closed = true): Pt[] {
  const segs: [Pt, Pt, number][] = [];
  let total = 0;
  const pts = closed ? [...path, path[0]] : path;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segs.push([pts[i], pts[i + 1], l]);
    total += l;
  }
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    let d = (k / n) * total;
    for (const [a, b, l] of segs) {
      if (d <= l || b === segs[segs.length - 1][1]) {
        const u = l ? Math.min(1, d / l) : 0;
        out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
        break;
      }
      d -= l;
    }
  }
  return out;
}

function roundRect(cx: number, cy: number, w: number, h: number, r: number): Pt[] {
  const p: Pt[] = [];
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
  const arc = (ox: number, oy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      p.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
    }
  };
  arc(x1 - r, y0 + r, -Math.PI / 2);
  arc(x1 - r, y1 - r, 0);
  arc(x0 + r, y1 - r, Math.PI / 2);
  arc(x0 + r, y0 + r, Math.PI);
  return p;
}

/** The file glyph (dog-eared page), centred at (cx, cy), `s` tall. */
function fileShape(cx: number, cy: number, s: number, rot = 0): Pt[] {
  const w = s * 0.74, h = s, f = s * 0.26;
  const raw: Pt[] = [
    [-w / 2, -h / 2], [w / 2 - f, -h / 2], [w / 2, -h / 2 + f], [w / 2, h / 2], [-w / 2, h / 2],
  ];
  const c = Math.cos(rot), sn = Math.sin(rot);
  return raw.map(([x, y]) => [cx + x * c - y * sn, cy + x * sn + y * c]);
}

function inPoly(x: number, y: number, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fill a polygon with n points (rejection sampling, deterministic). */
function fill(poly: Pt[], n: number, seed: number): Pt[] {
  const r = rng(seed);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out: Pt[] = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 60) {
    const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0);
    if (inPoly(x, y, poly)) out.push([x, y]);
  }
  while (out.length < n) out.push(out[out.length % Math.max(1, out.length)] ?? [(x0 + x1) / 2, (y0 + y1) / 2]);
  return out;
}

function laptop(cx: number, cy: number, s: number): Pt[][] {
  return [roundRect(cx, cy - s * 0.12, s, s * 0.62, s * 0.05), [[cx - s * 0.62, cy + s * 0.24], [cx + s * 0.62, cy + s * 0.24]]];
}

function phone(cx: number, cy: number, s: number): Pt[][] {
  return [roundRect(cx, cy, s * 0.5, s, s * 0.08), [[cx - s * 0.06, cy + s * 0.42], [cx + s * 0.06, cy + s * 0.42]]];
}

function folderShape(cx: number, cy: number, s: number): Pt[] {
  const w = s * 1.3, h = s * 0.9;
  return [
    [cx - w / 2, cy - h / 2], [cx - w / 2 + w * 0.36, cy - h / 2], [cx - w / 2 + w * 0.44, cy - h / 2 + h * 0.14],
    [cx + w / 2, cy - h / 2 + h * 0.14], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2],
  ];
}

/** Builder: fills particles [from, to) and leaves the rest as faint dust. */
class Build {
  f = new Float32Array(N * 4);
  private i = 0;
  constructor(_seed: number) {
    // WHY: the same dust in every formation, so it stays put between scenes.
    const r = rng(10);
    for (let k = 0; k < N; k++) {
      this.f.set([r() * W, r() * H, 0, 0.03 + r() * 0.07], k * 4);
    }
  }
  at(i: number) {
    this.i = i;
    return this;
  }
  put(pts: Pt[], color: number, alpha = 1) {
    for (const [x, y] of pts) {
      if (this.i >= N) break;
      this.f.set([x, y, color, alpha], this.i++ * 4);
    }
    return this;
  }
  outline(paths: Pt[][], n: number, color: number, alpha = 0.95) {
    const lens = paths.map((p) => p.length);
    const per = paths.map((_, k) => Math.round((n * lens[k]) / lens.reduce((a, b) => a + b, 0)));
    paths.forEach((p, k) => this.put(alongPath(p, Math.max(2, per[k]), p.length > 2), color, alpha));
    return this;
  }
}

const CX = W / 2, CY = H / 2 + 40;
const LEFT = [W * 0.24, CY + 60] as const, RIGHT = [W * 0.76, CY + 60] as const;

const F: Record<string, Formation> = {};
{
  // Scattered stars before the logo forms.
  F.scatter = new Build(1).f;

  // The logo: a marigold tile with the file cut out of it, file in ink.
  const logo = (cx: number, cy: number, s: number) => {
    const b = new Build(2);
    const tile = roundRect(cx, cy, s, s, s * 0.23);
    const file = fileShape(cx + s * 0.03, cy - s * 0.02, s * 0.48, -0.31);
    b.at(0).put(fill(file, PAYLOAD, 11), 0, 1);
    const tilePts = fill(tile, 9000, 12).filter(([x, y]) => !inPoly(x, y, file));
    b.put(tilePts.slice(0, 8200), 1, 0.85);
    return b.f;
  };
  F.logo = logo(CX, CY - 40, 420);
  F.logoEnd = logo(CX, CY - 70, 360);

  // Devices around you: one in the middle, five around it.
  const nb = new Build(3);
  nb.at(0).put(fill(fileShape(CX, CY - 40, 70), PAYLOAD, 21), 1, 0.9);
  nb.outline(laptop(CX, CY + 60, 190), 900, 0, 1);
  const ring = [
    [W * 0.2, H * 0.33, "laptop"], [W * 0.8, H * 0.33, "laptop"], [W * 0.13, H * 0.72, "phone"],
    [W * 0.87, H * 0.72, "phone"], [W * 0.5, H * 0.17, "laptop"],
  ] as const;
  for (const [x, y, kind] of ring) {
    nb.outline(kind === "phone" ? phone(x, y, 150) : laptop(x, y, 150), 700, 1, 0.95);
  }
  F.nearby = nb.f;

  // Send: two laptops, the file on the left … then on the right.
  const send = (side: "left" | "right", seed: number) => {
    const b = new Build(seed);
    const [fx, fy] = side === "left" ? LEFT : RIGHT;
    b.at(0).put(fill(fileShape(fx, fy - 70, 150, -0.2), PAYLOAD, 31), 1, 1);
    b.outline(laptop(LEFT[0], LEFT[1], 330), 2400, 0, 1);
    b.outline(laptop(RIGHT[0], RIGHT[1], 330), 2400, 0, 1);
    return b.f;
  };
  F.sendL = send("left", 4);
  F.sendR = send("right", 4);

  // Folders: a folder of little files on the left … then on the right.
  const folder = (side: "left" | "right") => {
    const b = new Build(5);
    const [fx, fy] = side === "left" ? LEFT : RIGHT;
    const fold = folderShape(fx, fy - 60, 190);
    // Nine small files inside the folder: the payload, in three columns.
    const files: Pt[] = [];
    for (let k = 0; k < 9; k++) {
      const gx = fx + ((k % 3) - 1) * 70, gy = fy - 80 + (Math.floor(k / 3) - 1) * 52;
      files.push(...fill(fileShape(gx, gy, 44), PAYLOAD / 9, 40 + k));
    }
    b.at(0).put(files, 1, 1);
    b.outline([fold], 700, 1, 0.55);
    b.outline(laptop(LEFT[0], LEFT[1] + 40, 360), 1200, 0, 0.9);
    b.outline(laptop(RIGHT[0], RIGHT[1] + 40, 360), 1200, 0, 0.9);
    return b.f;
  };
  F.folderL = folder("left");
  F.folderR = folder("right");

  // Phones: a phone on the left, the relay above, a laptop showing a QR code.
  const PH = [W * 0.2, CY + 40] as const, LP = [W * 0.78, CY + 60] as const, RELAY = [W * 0.5, H * 0.24] as const;
  const qr = (): Pt[] => {
    const r = rng(77), pts: Pt[] = [];
    for (let gy = 0; gy < 21; gy++)
      for (let gx = 0; gx < 21; gx++) {
        const finder = (a: number, b: number) => a < 7 && b < 7;
        const on = finder(gx, gy) || finder(20 - gx, gy) || finder(gx, 20 - gy) ? (gx % 6 === 0 || gy % 6 === 0 || (gx % 6 > 1 && gx % 6 < 5 && gy % 6 > 1 && gy % 6 < 5)) : r() < 0.5;
        // Each module is a little 2×2 block, so the code reads as a code.
        if (on) for (const [dx, dy] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) pts.push([LP[0] - 120 + gx * 12 + dx, LP[1] - 214 + gy * 12 + dy]);
      }
    return pts;
  };
  const hex = (cx: number, cy: number, s: number): Pt[] =>
    Array.from({ length: 6 }, (_, k) => [cx + Math.cos((k * Math.PI) / 3) * s, cy + Math.sin((k * Math.PI) / 3) * s]);
  const phones = (at: "phone" | "laptop") => {
    const b = new Build(6);
    const [fx, fy] = at === "phone" ? PH : LP;
    b.at(0).put(fill(fileShape(fx, fy - (at === "phone" ? 10 : 100), at === "phone" ? 110 : 140, -0.15), PAYLOAD, 51), 1, 1);
    b.outline(phone(PH[0], PH[1], 330), 900, 0, 1);
    b.outline(laptop(LP[0], LP[1], 380), 1300, 0, 1);
    b.outline([hex(RELAY[0], RELAY[1], 64)], 360, 1, 0.8);
    // The QR code is on screen while the phone pairs, then dims.
    b.put(qr(), 1, at === "phone" ? 1 : 0.3);
    return b.f;
  };
  F.phoneA = phones("phone");
  F.phoneB = phones("laptop");
}

// ---------- the score: which formation when, and how to move ----------

type Move = { t0: number; t1: number; from: string; to: string; arc?: number; ctrl?: Pt; spread?: number };
const MOVES: Move[] = [
  { t0: 0.5, t1: 4.5, from: "scatter", to: "logo", spread: 0.55 },
  { t0: 8.5, t1: 11.5, from: "logo", to: "nearby", spread: 0.5 },
  { t0: 20, t1: 23, from: "nearby", to: "sendL", spread: 0.45 },
  { t0: 26, t1: 33, from: "sendL", to: "sendR", arc: 420, spread: 0.7 },
  { t0: 36, t1: 39, from: "sendR", to: "folderL", spread: 0.45 },
  { t0: 40, t1: 46.5, from: "folderL", to: "folderR", arc: 380, spread: 0.75 },
  { t0: 48.5, t1: 51.5, from: "folderR", to: "phoneA", spread: 0.45 },
  { t0: 56, t1: 60.5, from: "phoneA", to: "phoneB", ctrl: [W * 0.5, -60], spread: 0.65 },
  { t0: 61, t1: 64.5, from: "phoneB", to: "logoEnd", spread: 0.55 },
];

/** Background events: rings (pings, the TLS handshake, arrival checks). */
const RINGS: [number, number, number, number][] = [
  // x, y, start, kind (0 ping, 1 check, 2 handshake)
  [W / 2, CY + 20, 12, 0], [W / 2, CY + 20, 14.4, 0], [W / 2, CY + 20, 16.8, 0],
  [LEFT[0], LEFT[1] - 70, 24, 2], [RIGHT[0], RIGHT[1] - 70, 24, 2],
  [RIGHT[0], RIGHT[1] - 70, 33.6, 1], [RIGHT[0], RIGHT[1] - 60, 46.8, 1], [W * 0.78, CY - 40, 60.6, 1],
];

// ---------- WebGL ----------

const VERT = `
attribute vec4 aFrom;   // x, y, color, alpha
attribute vec4 aTo;
attribute vec2 aMisc;   // delay 0..1, size
uniform float uP;       // progress of the current move, 0..1
uniform float uSpread;  // how much the particles are staggered
uniform float uArc;     // arc height (px); 0 = straight
uniform vec2 uCtrl;     // explicit control point (if uUseCtrl)
uniform float uUseCtrl;
uniform float uTime;
uniform vec2 uView;
uniform float uScale;
uniform float uFade;
varying vec4 vCol;
void main() {
  float u = clamp((uP - aMisc.x * uSpread) / (1.0 - uSpread), 0.0, 1.0);
  float e = u < 0.5 ? 4.0 * u * u * u : 1.0 - pow(-2.0 * u + 2.0, 3.0) / 2.0;
  vec2 a = aFrom.xy, b = aTo.xy;
  // WHY: only particles that really travel take the arc; the ones that
  // stay put (the devices, the relay) must not be pulled along it.
  float travel = smoothstep(30.0, 160.0, distance(a, b));
  vec2 mid = (a + b) * 0.5 + vec2(0.0, -uArc * travel);
  vec2 c = mix(mid, uCtrl, uUseCtrl * travel);
  vec2 p = mix(mix(a, c, e), mix(c, b, e), e);
  // A slow drift keeps still formations alive.
  p += vec2(sin(uTime * 0.7 + aMisc.x * 40.0), cos(uTime * 0.6 + aMisc.x * 31.0)) * 1.6;
  // Chunks in flight: a little flicker, like packets.
  float flying = step(0.001, u) * step(u, 0.999) * step(1.0, uArc + uUseCtrl) * travel;
  vec4 col = mix(aFrom.zwzw, aTo.zwzw, e);
  vCol = vec4(col.x, col.y * uFade, flying, 0.0);
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
  gl_PointSize = aMisc.y * uScale * (1.0 + flying * 0.9);
}`;

const FRAG = `
precision mediump float;
varying vec4 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  // Flying chunks are little sealed squares; everything else soft dots.
  float dot = smoothstep(0.5, 0.15, r);
  float sq = 1.0 - smoothstep(0.3, 0.38, max(abs(c.x), abs(c.y)));
  float shape = mix(dot, sq, vCol.z);
  vec3 ink = vec3(0.925, 0.933, 0.95);
  vec3 gold = vec3(0.949, 0.71, 0.227);
  gl_FragColor = vec4(mix(ink, gold, vCol.x), shape * vCol.y);
}`;

const BG_VERT = `attribute vec2 aQ; varying vec2 vUv; void main(){ vUv = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }`;
const BG_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform float uTime;
uniform vec2 uView;
uniform vec4 uRings[8];
uniform float uFade;
void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uView;
  vec3 base = mix(vec3(0.075, 0.082, 0.106), vec3(0.11, 0.1, 0.09), smoothstep(0.0, 1.0, vUv.y));
  // A slow marigold glow that drifts.
  vec2 g = uView * vec2(0.5 + 0.2 * sin(uTime * 0.05), 0.35 + 0.1 * cos(uTime * 0.04));
  float glow = exp(-length(px - g) / (uView.x * 0.35));
  vec3 col = base + vec3(0.35, 0.22, 0.05) * glow * 0.35;
  for (int i = 0; i < 8; i++) {
    vec4 r = uRings[i];
    float age = uTime - r.z;
    if (age < 0.0 || age > 2.2) continue;
    float kind = r.w;
    float radius = kind > 1.5 ? 220.0 * (1.0 - age / 1.2) : age * (kind > 0.5 ? 110.0 : 520.0) + 40.0;
    float w = kind > 0.5 ? 5.0 : 3.0;
    float ringA = (1.0 - smoothstep(0.0, w, abs(length(px - r.xy) - radius))) * (1.0 - age / 2.2);
    if (kind > 1.5 && age > 1.2) ringA = 0.0;
    col += vec3(0.95, 0.71, 0.23) * ringA * (kind > 0.5 ? 0.9 : 0.55);
  }
  // Vignette and the fade in/out.
  col *= 1.0 - 0.35 * length(vUv - 0.5);
  gl_FragColor = vec4(col * uFade, 1.0);
}`;

interface Film {
  render(t: number): void;
  resize(w: number, h: number): void;
  duration: number;
  captions: HTMLCanvasElement;
  gl: HTMLCanvasElement;
}

function createFilm(glCanvas: HTMLCanvasElement, capCanvas: HTMLCanvasElement, opts: { preserve?: boolean } = {}): Film {
  const gl = glCanvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: !!opts.preserve });
  if (!gl) throw new Error("WebGL is not available");
  const ctx = capCanvas.getContext("2d")!;

  const compile = (vs: string, fs: string) => {
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  };
  const pts = compile(VERT, FRAG);
  const bg = compile(BG_VERT, BG_FRAG);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const r = rng(99);
  const misc = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) misc.set([r(), i < PAYLOAD ? 3.2 : 2.2 + r() * 1.1], i * 2);
  const bFrom = gl.createBuffer(), bTo = gl.createBuffer(), bMisc = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bMisc);
  gl.bufferData(gl.ARRAY_BUFFER, misc, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, bFrom);
  gl.bufferData(gl.ARRAY_BUFFER, N * 16, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, bTo);
  gl.bufferData(gl.ARRAY_BUFFER, N * 16, gl.DYNAMIC_DRAW);

  const U = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const aFrom = gl.getAttribLocation(pts, "aFrom"), aTo = gl.getAttribLocation(pts, "aTo"), aMisc = gl.getAttribLocation(pts, "aMisc");
  const aQ = gl.getAttribLocation(bg, "aQ");
  const ringData = new Float32Array(RINGS.flat());

  let loaded = "";
  const load = (from: string, to: string) => {
    const key = `${from}>${to}`;
    if (key === loaded) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, bFrom);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, F[from]);
    gl.bindBuffer(gl.ARRAY_BUFFER, bTo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, F[to]);
    loaded = key;
  };

  let scale = 1;
  const resize = (w: number, h: number) => {
    glCanvas.width = capCanvas.width = w;
    glCanvas.height = capCanvas.height = h;
    scale = w / W;
    gl.viewport(0, 0, w, h);
  };
  resize(glCanvas.width || W, glCanvas.height || H);

  const captions = (t: number) => {
    ctx.clearRect(0, 0, capCanvas.width, capCanvas.height);
    const scene = timeline.scenes.find((s: Scene) => t >= s.start && t < s.end);
    if (!scene) return;
    const inA = Math.min(1, Math.max(0, (t - scene.start - 0.6) / 0.8));
    const outA = Math.min(1, Math.max(0, (scene.end - t - 0.2) / 0.6));
    const a = Math.min(inA, outA) * fade(t);
    if (a <= 0) return;
    const s = scale;
    ctx.save();
    ctx.globalAlpha = a;
    // A soft dark band so the words stay readable over the particles.
    const band = ctx.createLinearGradient(0, (H - 300) * s, 0, H * s);
    band.addColorStop(0, "rgba(12,13,17,0)");
    band.addColorStop(0.45, "rgba(12,13,17,0.7)");
    band.addColorStop(1, "rgba(12,13,17,0.85)");
    ctx.fillStyle = band;
    ctx.fillRect(0, (H - 300) * s, W * s, 300 * s);
    ctx.textAlign = "center";
    ctx.fillStyle = "#eceef2";
    ctx.font = `700 ${Math.round(64 * s)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", sans-serif`;
    // WHY: always at the bottom; the formations keep the lower band clear.
    const y = H - 150;
    ctx.fillText(scene.caption, (W / 2) * s, (y + (1 - inA) * 12) * s);
    ctx.fillStyle = "#b9bfcc";
    ctx.font = `400 ${Math.round(30 * s)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", sans-serif`;
    ctx.fillText(scene.sub, (W / 2) * s, (y + 56 + (1 - inA) * 12) * s);
    ctx.restore();
  };

  const fade = (t: number) => Math.min(1, t / 0.8, Math.max(0, (timeline.duration - t) / 2));

  const render = (t: number) => {
    // Which move applies: inside one, or holding the last formation.
    let move = MOVES[0], p = 0;
    for (const m of MOVES) {
      if (t >= m.t0) {
        move = m;
        p = Math.min(1, (t - m.t0) / (m.t1 - m.t0));
      }
    }
    if (t < MOVES[0].t0) p = 0;
    load(move.from, move.to);
    const f = fade(t);

    gl.disable(gl.BLEND);
    gl.useProgram(bg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aQ);
    gl.vertexAttribPointer(aQ, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(U(bg, "uTime"), t);
    gl.uniform2f(U(bg, "uView"), W, H);
    gl.uniform1f(U(bg, "uFade"), f);
    gl.uniform4fv(U(bg, "uRings"), ringData);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(aQ);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(pts);
    const attr = (loc: number, buf: WebGLBuffer | null, size: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr(aFrom, bFrom, 4);
    attr(aTo, bTo, 4);
    attr(aMisc, bMisc, 2);
    gl.uniform1f(U(pts, "uP"), p);
    gl.uniform1f(U(pts, "uSpread"), move.spread ?? 0.5);
    gl.uniform1f(U(pts, "uArc"), move.arc ?? 0);
    gl.uniform2fv(U(pts, "uCtrl"), move.ctrl ?? [0, 0]);
    gl.uniform1f(U(pts, "uUseCtrl"), move.ctrl ? 1 : 0);
    gl.uniform1f(U(pts, "uTime"), t);
    gl.uniform2f(U(pts, "uView"), W, H);
    gl.uniform1f(U(pts, "uScale"), scale);
    gl.uniform1f(U(pts, "uFade"), f);
    gl.drawArrays(gl.POINTS, 0, N);
    gl.disableVertexAttribArray(aFrom);
    gl.disableVertexAttribArray(aTo);
    gl.disableVertexAttribArray(aMisc);

    captions(t);
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
    // Poster: the logo. The visitor starts it.
    t = 66;
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
