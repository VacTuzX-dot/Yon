// The film's renderer: a voxel world drawn at low resolution, then scaled up
// through a pixel-art pass (posterise + ordered dither + dissolve wipes).
// Plain WebGL 1, no library: this origin runs no third-party code.
//
// Two kinds of geometry:
//   - the static world, meshed once from voxels (hidden faces dropped, voxel
//     ambient occlusion and face shading baked into the vertex colours);
//   - "cubes": boxes with a centre, size, colour and rotation, rebuilt every
//     frame for everything that moves (people, devices, flying chunks).
// Every frame is a pure function of the scene state handed to draw(), so the
// same time always gives the same picture.

export type V3 = [number, number, number];
export type RGB = [number, number, number];

/** One moving box. p = centre, s = size, rx/ry = rotation (radians) about its centre. */
export interface Cube {
  p: V3;
  s: V3;
  c: RGB;
  /** 0 = lit and textured, 1 = glows (screens, lights, sealed chunks). */
  e?: number;
  rx?: number;
  ry?: number;
}

export interface Frame {
  eye: V3;
  look: V3;
  fov: number; // vertical, degrees
  cubes: Cube[];
  /** Tint of the light on lit surfaces. */
  light: RGB;
  fog: RGB;
  fogDensity: number;
  skyTop: RGB;
  skyBottom: RGB;
  /** 0 black … 1 full picture. */
  fade: number;
  /** 0 … 1: the pixel dissolve covering the picture. */
  wipe: number;
}

// ---------- vectors and matrices (column-major, like GL) ----------

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const lerp3 = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function viewProj(eye: V3, look: V3, fovDeg: number, aspect: number): Float32Array {
  const f = norm(sub(look, eye));
  const s = norm(cross(f, [0, 1, 0]));
  const u = cross(s, f);
  const view = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1];
  const near = 1, far = 1000;
  const t = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const proj = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += proj[k * 4 + r] * view[c * 4 + k];
      out[c * 4 + r] = v;
    }
  return out;
}

/** World point → design-space pixels (W×H), or null when behind the camera or off screen. */
export function project(vp: Float32Array, p: V3, W: number, H: number): [number, number] | null {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 0.1) return null;
  const sx = ((x / w) * 0.5 + 0.5) * W, sy = (1 - ((y / w) * 0.5 + 0.5)) * H;
  if (sx < -200 || sx > W + 200 || sy < -200 || sy > H + 200) return null;
  return [sx, sy];
}

// ---------- voxels ----------

export interface PaletteEntry {
  c: RGB;
  e?: number;
}

const key = (x: number, y: number, z: number) => ((x + 1024) * 512 + (y + 128)) * 2048 + (z + 1024);

/** A sparse voxel world; values index a palette. */
export class Voxels {
  map = new Map<number, number>();
  set(x: number, y: number, z: number, v: number) {
    this.map.set(key(x, y, z), v);
  }
  get(x: number, y: number, z: number) {
    return this.map.get(key(x, y, z));
  }
  del(x: number, y: number, z: number) {
    this.map.delete(key(x, y, z));
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, v);
  }
  clear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.del(x, y, z);
  }
}

const FLOATS = 10; // x y z  r g b e  nx ny nz

// Per face: normal, the 4 corners (as offsets of the unit cube) and a shade.
const FACES: { n: V3; c: V3[]; shade: number }[] = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.8 },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.8 },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.52 },
  { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], shade: 0.66 },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.66 },
];
const AO = [0.5, 0.68, 0.84, 1];

/** Mesh the voxels: exposed faces only, with ambient occlusion per corner. */
export function meshVoxels(vox: Voxels, palette: PaletteEntry[]): Float32Array {
  const out: number[] = [];
  const solid = (x: number, y: number, z: number) => vox.get(x, y, z) !== undefined;
  for (const [k, v] of vox.map) {
    const z = (k % 2048) - 1024;
    const y = (Math.floor(k / 2048) % 512) - 128;
    const x = Math.floor(k / 2048 / 512) - 1024;
    const pal = palette[v];
    // A little per-voxel variation, like a block texture.
    const h = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
    const jitter = pal.e ? 1 : 0.94 + ((h % 1000) / 1000) * 0.1;
    for (const f of FACES) {
      const [nx, ny, nz] = f.n;
      if (solid(x + nx, y + ny, z + nz)) continue;
      // The two edge neighbours and the corner neighbour, one layer out.
      const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
      const [u, w] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
      const ao = f.c.map((c) => {
        if (pal.e) return 1;
        const o = [x + nx, y + ny, z + nz];
        const du = [0, 0, 0], dw = [0, 0, 0];
        du[u] = c[u] * 2 - 1;
        dw[w] = c[w] * 2 - 1;
        const s1 = solid(o[0] + du[0], o[1] + du[1], o[2] + du[2]) ? 1 : 0;
        const s2 = solid(o[0] + dw[0], o[1] + dw[1], o[2] + dw[2]) ? 1 : 0;
        const cc = solid(o[0] + du[0] + dw[0], o[1] + du[1] + dw[1], o[2] + du[2] + dw[2]) ? 1 : 0;
        return AO[s1 && s2 ? 0 : 3 - (s1 + s2 + cc)];
      });
      const vert = (i: number) => {
        const c = f.c[i];
        const k2 = f.shade * ao[i] * jitter;
        out.push(x + c[0], y + c[1], z + c[2], pal.c[0] * k2, pal.c[1] * k2, pal.c[2] * k2, pal.e ?? 0, nx, ny, nz);
      };
      // Flip the quad's diagonal so AO interpolates without a crease.
      if (ao[0] + ao[2] > ao[1] + ao[3]) [1, 2, 3, 1, 3, 0].forEach(vert);
      else [0, 1, 2, 0, 2, 3].forEach(vert);
    }
  }
  return new Float32Array(out);
}

function meshCubes(cubes: Cube[], buf: Float32Array): number {
  let o = 0;
  for (const cb of cubes) {
    if (o + 36 * FLOATS > buf.length) break;
    const [cx, cy, cz] = cb.p;
    const [sx, sy, sz] = cb.s;
    if (sx <= 0 || sy <= 0 || sz <= 0) continue;
    const rx = cb.rx ?? 0, ry = cb.ry ?? 0;
    const cxr = Math.cos(rx), sxr = Math.sin(rx), cyr = Math.cos(ry), syr = Math.sin(ry);
    const rot = (x: number, y: number, z: number): V3 => {
      // rx first (about x), then ry (about y)
      const y1 = y * cxr - z * sxr, z1 = y * sxr + z * cxr;
      return [x * cyr + z1 * syr, y1, -x * syr + z1 * cyr];
    };
    const e = cb.e ?? 0;
    for (const f of FACES) {
      const n = rot(f.n[0], f.n[1], f.n[2]);
      // Shade from the rotated normal: up is bright, sides mid, down dark.
      const shade = e ? 1 : n[1] >= 0 ? 0.66 + 0.34 * n[1] + 0.14 * Math.abs(n[0]) * (1 - n[1]) : 0.66 + 0.14 * Math.abs(n[0]) + 0.14 * n[1];
      const pts = f.c.map((c) => {
        const r = rot((c[0] - 0.5) * sx, (c[1] - 0.5) * sy, (c[2] - 0.5) * sz);
        return [cx + r[0], cy + r[1], cz + r[2]];
      });
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const p = pts[i];
        buf.set([p[0], p[1], p[2], cb.c[0] * shade, cb.c[1] * shade, cb.c[2] * shade, e, n[0], n[1], n[2]], o);
        o += FLOATS;
      }
    }
  }
  return o / FLOATS;
}

// ---------- shaders ----------

const VOX_VS = `
attribute vec3 aP; attribute vec4 aC; attribute vec3 aN;
uniform mat4 uVP;
varying vec4 vC; varying vec3 vW; varying vec3 vN;
void main() { vC = aC; vW = aP; vN = aN; gl_Position = uVP * vec4(aP, 1.0); }`;

const VOX_FS = `
precision highp float;
varying vec4 vC; varying vec3 vW; varying vec3 vN;
uniform vec3 uEye, uLight, uFog; uniform float uFogD;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
void main() {
  // A 4x4-texel "block texture" in world space, stepped in from the face so
  // the texel never flickers between two cells.
  vec3 q = floor((vW - vN * 0.01) * 4.0);
  float tex = mix(0.95 + 0.08 * hash(q), 1.0, vC.a);
  vec3 lit = vC.rgb * tex * mix(uLight, vec3(1.0), vC.a) + vC.rgb * vC.a * 0.25;
  float d = distance(vW, uEye) * uFogD;
  float f = 1.0 - exp(-d * d);
  gl_FragColor = vec4(mix(lit, uFog, f * (1.0 - 0.6 * vC.a)), 1.0);
}`;

const QUAD_VS = `attribute vec2 aQ; varying vec2 vUv; void main(){ vUv = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }`;

const SKY_FS = `
precision highp float; varying vec2 vUv;
uniform vec3 uTop, uBot; uniform float uPitch;
void main() {
  float k = clamp(vUv.y * 0.9 + 0.1 + uPitch, 0.0, 1.0);
  gl_FragColor = vec4(mix(uBot, uTop, k * k * (3.0 - 2.0 * k)), 1.0);
}`;

// The pixel pass: nearest-neighbour upscale, posterise with a 4x4 ordered
// dither (in low-res pixels), a soft vignette, the fade, and the dissolve
// wipe (a coarser dither pattern that fills in block by block).
const POST_FS = `
precision highp float; varying vec2 vUv;
uniform sampler2D uTex; uniform vec2 uLow; uniform float uFade, uWipe;
float b2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer(vec2 a) { return b2(0.5 * a) * 0.25 + b2(a); }
void main() {
  vec2 lp = floor(vUv * uLow);
  vec3 c = texture2D(uTex, (lp + 0.5) / uLow).rgb;
  float d = bayer(lp);
  vec2 v = vUv - 0.5;
  c *= 1.0 - 0.35 * dot(v, v);
  c *= uFade;
  c = floor(c * 14.0 + d) / 14.0;
  float cell = bayer(floor(lp / 4.0));
  if (cell < uWipe) {
    // Paper and marigold blocks, like the site.
    c = mod(floor(lp.x / 4.0) + floor(lp.y / 4.0), 3.0) < 0.5 ? vec3(0.95, 0.64, 0.09) : vec3(0.98, 0.97, 0.94);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export interface Engine {
  draw(f: Frame): Float32Array; // returns the view-projection used (for overlays)
  resize(w: number, h: number): void;
}

/** low = size of the pixel buffer (the film's "resolution"). */
export function createEngine(canvas: HTMLCanvasElement, world: Float32Array, low: [number, number], preserve = false): Engine {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: preserve });
  if (!gl) throw new Error("WebGL is not available");

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
  const vox = compile(VOX_VS, VOX_FS);
  const sky = compile(QUAD_VS, SKY_FS);
  const post = compile(QUAD_VS, POST_FS);
  const U = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const worldBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, worldBuf);
  gl.bufferData(gl.ARRAY_BUFFER, world, gl.STATIC_DRAW);
  const worldCount = world.length / FLOATS;

  const MAX_CUBES = 6000;
  const dyn = new Float32Array(MAX_CUBES * 36 * FLOATS);
  const dynBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
  gl.bufferData(gl.ARRAY_BUFFER, dyn.byteLength, gl.DYNAMIC_DRAW);

  // The low-resolution target.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, low[0], low[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  // WHY: DEPTH_STENCIL is 24-bit depth on every GPU; 16-bit z-fought on thin screens.
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, low[0], low[1]);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const aP = gl.getAttribLocation(vox, "aP"), aC = gl.getAttribLocation(vox, "aC"), aN = gl.getAttribLocation(vox, "aN");
  const aQs = gl.getAttribLocation(sky, "aQ"), aQp = gl.getAttribLocation(post, "aQ");

  const drawQuad = (loc: number) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(loc);
  };
  const drawMesh = (buf: WebGLBuffer | null, count: number) => {
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const st = FLOATS * 4;
    gl.enableVertexAttribArray(aP);
    gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(aN);
    gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, st, 28);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.disableVertexAttribArray(aP);
    gl.disableVertexAttribArray(aC);
    gl.disableVertexAttribArray(aN);
  };

  const draw = (f: Frame) => {
    const vp = viewProj(f.eye, f.look, f.fov, low[0] / low[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, low[0], low[1]);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky);
    const dir = norm(sub(f.look, f.eye));
    gl.uniform3fv(U(sky, "uTop"), f.skyTop);
    gl.uniform3fv(U(sky, "uBot"), f.skyBottom);
    gl.uniform1f(U(sky, "uPitch"), dir[1] * 0.8);
    drawQuad(aQs);

    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW); // every face in FACES winds counter-clockwise seen from outside
    gl.useProgram(vox);
    gl.uniformMatrix4fv(U(vox, "uVP"), false, vp);
    gl.uniform3fv(U(vox, "uEye"), f.eye);
    gl.uniform3fv(U(vox, "uLight"), f.light);
    gl.uniform3fv(U(vox, "uFog"), f.fog);
    gl.uniform1f(U(vox, "uFogD"), f.fogDensity);
    drawMesh(worldBuf, worldCount);
    const n = meshCubes(f.cubes, dyn);
    gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, dyn.subarray(0, n * FLOATS));
    drawMesh(dynBuf, n);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(post);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(U(post, "uTex"), 0);
    gl.uniform2f(U(post, "uLow"), low[0], low[1]);
    gl.uniform1f(U(post, "uFade"), f.fade);
    gl.uniform1f(U(post, "uWipe"), f.wipe);
    drawQuad(aQp);
    return vp;
  };

  const resize = (w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
  };
  return { draw, resize };
}
