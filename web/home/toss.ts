// The hero animation: a file leaves the left laptop as a stream of sealed
// chunks, flies the arc, and is put back together (and checked) on the right.
// Plain WebGL, no library: this page shares an origin with the phone page,
// so nothing third-party runs here. Without WebGL, or with reduced motion,
// the static SVG underneath stays as it is.

const PERIOD = 4.2; // seconds per toss
const CHUNKS = 26;
const SPARKS = 90;

// The arc in the SVG's viewBox (640 × 220): see web/home/index.html.
const P0 = [110, 92], P1 = [220, -10], P2 = [420, -10], P3 = [530, 92];

const VERT = `
attribute vec4 a; // x: phase 0..1, y: lane -1..1, z: size, w: kind (0 chunk, 1 spark)
uniform float t;
uniform vec2 view;
uniform vec2 p0, p1, p2, p3;
varying float alpha;
varying float kind;
vec2 bez(float u) {
  float v = 1.0 - u;
  return v*v*v*p0 + 3.0*v*v*u*p1 + 3.0*v*u*u*p2 + u*u*u*p3;
}
void main() {
  kind = a.w;
  // Each chunk leaves a little after the one before it, so the file
  // "unzips" off the left laptop and zips back together on the right.
  float start = a.x * 0.35;
  float u = clamp((t - start) / 0.55, 0.0, 1.0);
  float e = u * u * (3.0 - 2.0 * u);
  vec2 p = bez(e);
  // Spread sideways mid-flight, tight at both ends.
  vec2 d = normalize(bez(min(e + 0.01, 1.0)) - bez(max(e - 0.01, 0.0)));
  p += vec2(-d.y, d.x) * a.y * 10.0 * sin(3.14159 * e);
  if (a.w > 0.5) {
    // Sparks trail behind the stream and fade.
    float s = fract(t * 1.7 + a.x);
    p = bez(s) + vec2(-d.y, d.x) * a.y * 16.0 * sin(3.14159 * s);
    alpha = (1.0 - s) * 0.5 * smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.85, 1.0, t));
  } else {
    alpha = (u > 0.0 && u < 1.0) ? 1.0 : 0.0;
  }
  gl_Position = vec4(p.x / view.x * 2.0 - 1.0, 1.0 - p.y / view.y * 2.0, 0.0, 1.0);
  gl_PointSize = a.z;
}`;

const FRAG = `
precision mediump float;
uniform vec3 accent;
varying float alpha;
varying float kind;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  // Chunks: rounded squares (sealed packets). Sparks: soft dots.
  float shape = kind > 0.5
    ? smoothstep(0.5, 0.0, r)
    : 1.0 - smoothstep(0.28, 0.36, max(abs(c.x), abs(c.y)));
  float glow = kind > 0.5 ? 1.0 : 0.85 + 0.15 * smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(accent * glow, shape * alpha);
}`;

function start(svg: SVGSVGElement) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.className = "toss-gl";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return;

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  // Deterministic "random" so every visit looks the same.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const data: number[] = [];
  for (let i = 0; i < CHUNKS; i++) data.push(i / CHUNKS, rnd() * 2 - 1, 0, 0);
  for (let i = 0; i < SPARKS; i++) data.push(rnd(), rnd() * 2 - 1, 0, 1);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);

  const u = (n: string) => gl.getUniformLocation(prog, n);
  gl.uniform2f(u("view"), 640, 220);
  gl.uniform2fv(u("p0"), P0);
  gl.uniform2fv(u("p1"), P1);
  gl.uniform2fv(u("p2"), P2);
  gl.uniform2fv(u("p3"), P3);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e8a317";
  const hex = parseInt(accent.replace("#", ""), 16);
  gl.uniform3f(u("accent"), ((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const tLoc = u("t");

  let scale = 1;
  const resize = () => {
    const r = svg.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
    scale = (r.width / 640) * dpr;
    // Sizes are in device pixels; keep them proportional to the picture.
    const sized = data.slice();
    for (let i = 0; i < CHUNKS + SPARKS; i++) sized[i * 4 + 2] = (i < CHUNKS ? 11 : 4) * scale;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sized), gl.STATIC_DRAW);
  };
  const stage = svg.parentElement!;
  stage.classList.add("live");
  stage.insertBefore(canvas, svg.nextSibling);
  svg.classList.add("live"); // CSS hides the static file and plays the step labels
  resize();
  new ResizeObserver(resize).observe(svg);

  // Sound (scripts/toss_sound.py) is off until asked for. While it plays,
  // its clock drives the picture, so they can't drift apart.
  const audio = new Audio("toss.wav");
  audio.loop = true;
  audio.preload = "none";
  const button = stage.querySelector<HTMLButtonElement>("button.sound");
  if (button) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const on = audio.paused;
      if (on) {
        audio.currentTime = 0;
        try {
          await audio.play();
        } catch {
          return; // blocked or unsupported: stay silent
        }
      } else {
        audio.pause();
      }
      button.setAttribute("aria-pressed", String(on));
      button.textContent = on ? "Sound off" : "Sound on";
    });
  }

  // Only draw while the picture is on screen and the tab is visible.
  let visible = true;
  let raf = 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    const seconds = audio.paused ? (now - t0) / 1000 : audio.currentTime;
    const t = (seconds % PERIOD) / PERIOD;
    stage.style.setProperty("--phase", t.toFixed(3));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(tLoc, t);
    gl.drawArrays(gl.POINTS, 0, CHUNKS + SPARKS);
    raf = visible ? requestAnimationFrame(frame) : 0;
  };
  const run = (on: boolean) => {
    visible = on && !document.hidden;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  };
  new IntersectionObserver(([e]) => run(e.isIntersecting)).observe(svg);
  document.addEventListener("visibilitychange", () => run(!document.hidden));
}

const svg = document.querySelector<SVGSVGElement>("svg.toss");
if (svg) {
  try {
    start(svg);
  } catch {
    // Any WebGL trouble: the static picture is already there.
  }
}
