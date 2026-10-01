// Renders the Yon explainer film (web/film/) to dist-film/yon-film.mp4 and a
// poster dist-film/yon-film.jpg.
//
//   bun run scripts/render-film.ts                     # full film
//   bun run scripts/render-film.ts --seconds 20..24    # quick check of a slice
//   bun run scripts/render-film.ts --frames-only       # PNGs only, kept in dist-film/frames
//   FILM=web/reel bun run scripts/render-film.ts       # the editorial reel -> dist-film/yon-reel.mp4
//
// Pipeline: Bun.build bundles the film script -> Bun.serve (127.0.0.1, random
// port) serves the film page with a driver script -> headless Chromium calls
// window.filmRenderFrame(t) for every frame and POSTs each PNG back -> ffmpeg
// encodes 1080p60 H.264 + AAC.
//
// Options:
//   --seconds a..b   render only [a, b) seconds (output gets a -part suffix)
//   --fps n          override the timeline fps
//   --frames-only    skip ffmpeg; copy the PNGs to dist-film/frames/
//   --entry path     film script to bundle (default web/film/film.ts)
//   --html path      page to load (default web/film/index.html when --entry is
//                    the default, else a minimal generated page)
//   --audio path     soundtrack (default web/film/film.wav)
//   --no-audio       encode without sound
//   --timeout min    overall timeout in minutes (default 90)
//   --keep-tmp       leave the temp dir for inspection
//
// The film page must, when its URL contains ?render, expose
//   window.filmReady: Promise<void>
//   window.filmRenderFrame(t: number): Promise<Blob>   // PNG, width x height
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
// FILM=web/reel renders the editorial reel instead of the voxel film.
const FILM_DIR = join(ROOT, process.env.FILM || "web/film");
const NAME = FILM_DIR.endsWith("reel") ? "yon-reel" : "yon-film";
const OUT_DIR = join(ROOT, "dist-film");
const STALL_MS = 120_000; // no frame for this long = the page is stuck
const POSTER_T = 64;

// ---------- options ----------
type Opts = {
  from: number;
  to: number | null;
  fps: number | null;
  framesOnly: boolean;
  entry: string;
  html: string | null;
  audio: string | null;
  timeoutMin: number;
  keepTmp: boolean;
};

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    from: 0,
    to: null,
    fps: null,
    framesOnly: false,
    entry: join(FILM_DIR, "film.ts"),
    html: null,
    audio: join(FILM_DIR, "film.wav"),
    timeoutMin: 90,
    keepTmp: false,
  };
  let customEntry = false;
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--seconds": {
        const m = /^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/.exec(need(i, a));
        if (!m) die("--seconds wants a..b, e.g. --seconds 0..2");
        o.from = Number(m[1]);
        o.to = Number(m[2]);
        if (!(o.to > o.from)) die("--seconds: b must be greater than a");
        i++;
        break;
      }
      case "--fps": {
        const n = Number(need(i, a));
        if (!Number.isInteger(n) || n < 1 || n > 240) die("--fps must be an integer 1..240");
        o.fps = n;
        i++;
        break;
      }
      case "--timeout": {
        const n = Number(need(i, a));
        if (!(n > 0)) die("--timeout must be minutes > 0");
        o.timeoutMin = n;
        i++;
        break;
      }
      case "--entry":
        o.entry = resolve(need(i, a));
        customEntry = true;
        i++;
        break;
      case "--html":
        o.html = resolve(need(i, a));
        i++;
        break;
      case "--audio":
        o.audio = resolve(need(i, a));
        i++;
        break;
      case "--no-audio":
        o.audio = null;
        break;
      case "--frames-only":
        o.framesOnly = true;
        break;
      case "--keep-tmp":
        o.keepTmp = true;
        break;
      case "-h":
      case "--help":
        console.log(Bun.file(import.meta.path).toString());
        process.exit(0);
      default:
        die(`unknown option ${a}`);
    }
  }
  if (!o.html && !customEntry) o.html = join(FILM_DIR, "index.html");
  return o;
}

function die(msg: string): never {
  console.error(`render-film: ${msg}`);
  process.exit(1);
}

// ---------- tool discovery ----------
function findBrowser(): string {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    Bun.which("chromium"),
    Bun.which("google-chrome"),
    // WHY: extra fallbacks after the preferred list, never before it.
    Bun.which("chromium-browser"),
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  die("no Chromium-based browser found. Install Chrome/Brave/Chromium or set CHROME=/path/to/binary");
}

function findTool(name: string): string {
  const p = Bun.which(name);
  if (!p) die(`${name} not found on PATH (brew install ffmpeg)`);
  return p;
}

async function run(cmd: string[], label: string): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${label} failed (exit ${code}):\n${err.trim().slice(-2000)}`);
  return out;
}

// ---------- page ----------
const DEFAULT_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}</style></head><body></body></html>`;

function renderPage(html: string, entryStem: string): string {
  // WHY: the render page is local-only; the film's own CSP would block the
  // inline flag and the driver, so drop it here (the shipped page keeps it).
  let out = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  // Drop the page's own reference to the film script; we inject the bundle.
  const stem = entryStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(
    new RegExp(`<script[^>]*\\ssrc\\s*=\\s*["']?[^"'>]*${stem}\\.(?:ts|js)[^>]*>\\s*</script>`, "gi"),
    "",
  );
  // Subresource Integrity on other tags would not match rebuilt files.
  out = out.replace(/\sintegrity\s*=\s*["'][^"']*["']/gi, "");
  const inject =
    `<script>window.__FILM_RENDER__=true</script>` +
    `<script type="module" src="/__film.js"></script>` +
    `<script type="module" src="/__driver.js"></script>`;
  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${inject}</body>`) : out + inject;
}

function driverJs(first: number, count: number, fps: number, token: string): string {
  // Runs in the page. Keeps up to 3 uploads in flight so PNG upload overlaps
  // with drawing the next frame; frame order on disk comes from ?i=.
  return `
const TOKEN=${JSON.stringify(token)}, FIRST=${first}, COUNT=${count}, FPS=${fps};
const post=(path,body)=>fetch(path+(path.includes("?")?"&":"?")+"k="+TOKEN,{method:"POST",body});
const fail=(m)=>post("/error",String(m)).catch(()=>{});
addEventListener("error",e=>fail("page error: "+(e.error&&e.error.stack||e.message)));
addEventListener("unhandledrejection",e=>fail("unhandled rejection: "+(e.reason&&e.reason.stack||e.reason)));
(async()=>{
  try{
    const t0=performance.now();
    while(!window.filmReady||!window.filmRenderFrame){
      if(performance.now()-t0>60000) throw new Error("window.filmReady / filmRenderFrame never appeared (is ?render handled?)");
      await new Promise(r=>setTimeout(r,50));
    }
    await window.filmReady;
    await post("/ready","");
    const inflight=new Set();
    for(let n=0;n<COUNT;n++){
      const blob=await window.filmRenderFrame((FIRST+n)/FPS);
      if(!(blob instanceof Blob)||blob.size===0) throw new Error("filmRenderFrame returned no Blob at frame "+(FIRST+n));
      const p=post("/frame?i="+n,blob).then(r=>{if(!r.ok) throw new Error("upload "+n+" -> HTTP "+r.status)}).finally(()=>inflight.delete(p));
      inflight.add(p);
      if(inflight.size>=3) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    await post("/done","");
  }catch(e){ fail(e&&e.stack||e); }
})();
`;
}

// ---------- main ----------
async function main() {
  const t0 = performance.now();
  const opts = parseArgs(Bun.argv.slice(2));
  const timeline = await Bun.file(join(FILM_DIR, "timeline.json")).json();
  const fps: number = opts.fps ?? timeline.fps;
  const width: number = timeline.width;
  const height: number = timeline.height;
  const duration: number = timeline.duration;
  const to = Math.min(opts.to ?? duration, duration);
  if (opts.from >= to) die(`--seconds start ${opts.from} is past the film end (${duration}s)`);
  const first = Math.round(opts.from * fps);
  const count = Math.round(to * fps) - first;
  const partial = opts.from > 0 || to < duration;

  if (!existsSync(opts.entry)) die(`film script not found: ${opts.entry} (use --entry to point at another)`);
  if (opts.html && !existsSync(opts.html)) die(`page not found: ${opts.html} (use --html)`);
  if (!opts.framesOnly && opts.audio && !existsSync(opts.audio))
    die(`soundtrack not found: ${opts.audio} (use --audio path or --no-audio)`);
  const browser = findBrowser();
  const ffmpeg = opts.framesOnly ? "" : findTool("ffmpeg");

  // Frames are big (~4,300 PNGs): RENDER_TMP can point at a roomier disk.
  const base = process.env.RENDER_TMP || tmpdir();
  const tmp = mkdtempSync(join(base, "render-film-"));
  const framesDir = join(tmp, "frames");
  const bundleDir = join(tmp, "bundle");
  mkdirSync(framesDir);
  mkdirSync(bundleDir);

  let browserProc: ReturnType<typeof Bun.spawn> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (browserProc && browserProc.exitCode === null) {
      browserProc.kill("SIGTERM");
      const exited = await Promise.race([browserProc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!exited) browserProc.kill("SIGKILL");
    }
    server?.stop(true);
    // WHY: only ever remove the dir mkdtemp gave us.
    if (!opts.keepTmp && basename(tmp).startsWith("render-film-") && tmp.startsWith(base)) {
      rmSync(tmp, { recursive: true, force: true });
    } else if (opts.keepTmp) console.log(`kept ${tmp}`);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      console.error(`\nrender-film: ${sig}, cleaning up`);
      cleanup().finally(() => process.exit(130));
    });
  }

  try {
    // 1. bundle
    const build = await Bun.build({
      entrypoints: [opts.entry],
      outdir: bundleDir,
      naming: { entry: "__film.js", chunk: "[name]-[hash].js", asset: "[name]-[hash].[ext]" },
      target: "browser",
      minify: true,
    });
    if (!build.success) {
      for (const log of build.logs) console.error(log);
      throw new Error("bundling the film script failed");
    }
    const pageHtml = renderPage(
      opts.html ? await Bun.file(opts.html).text() : DEFAULT_HTML,
      basename(opts.entry, extname(opts.entry)),
    );
    const pageDir = opts.html ? dirname(opts.html) : null;
    const token = randomBytes(16).toString("hex");
    const driver = driverJs(first, count, fps, token);

    // 2. serve
    let received = 0;
    let lastFrameAt = performance.now();
    let renderStart = 0;
    let settle!: { ok: () => void; fail: (e: Error) => void };
    const finished = new Promise<void>((ok, fail) => (settle = { ok, fail }));

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 64 * 1024 * 1024,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        if (req.method === "POST") {
          // WHY: the port is reachable by any local process; a per-run token
          // keeps stray requests from writing files into the frames dir.
          if (url.searchParams.get("k") !== token) return new Response("forbidden", { status: 403 });
          if (path === "/frame") {
            const i = Number(url.searchParams.get("i"));
            if (!Number.isInteger(i) || i < 0 || i >= count) return new Response("bad index", { status: 400 });
            const buf = new Uint8Array(await req.arrayBuffer());
            // PNG magic: 89 50 4E 47
            if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
              settle.fail(new Error(`frame ${first + i} is not a PNG`));
              return new Response("not png", { status: 400 });
            }
            if (i === 0) {
              const w = new DataView(buf.buffer).getUint32(16);
              const h = new DataView(buf.buffer).getUint32(20);
              if (w !== width || h !== height) {
                settle.fail(new Error(`frame is ${w}x${h}, expected ${width}x${height}`));
                return new Response("bad size", { status: 400 });
              }
            }
            await Bun.write(join(framesDir, `${String(i).padStart(5, "0")}.png`), buf);
            received++;
            lastFrameAt = performance.now();
            if (received % fps === 0 || received === count) {
              const el = (performance.now() - renderStart) / 1000;
              const pct = ((received / count) * 100).toFixed(1).padStart(5);
              console.log(
                `  t=${((first + received) / fps).toFixed(1).padStart(5)}s  ${pct}%  ` +
                  `${(received / el).toFixed(1)} frames/s  eta ${Math.round((count - received) / (received / el))}s`,
              );
            }
            return new Response("ok");
          }
          if (path === "/ready") {
            renderStart = performance.now();
            lastFrameAt = renderStart;
            console.log(`page ready after ${((renderStart - t0) / 1000).toFixed(1)}s, rendering ${count} frames`);
            return new Response("ok");
          }
          if (path === "/done") {
            if (received !== count) settle.fail(new Error(`done after ${received}/${count} frames`));
            else settle.ok();
            return new Response("ok");
          }
          if (path === "/error") {
            settle.fail(new Error(`in page: ${await req.text()}`));
            return new Response("ok");
          }
          return new Response("not found", { status: 404 });
        }
        if (path === "/" || path === "/render.html") {
          return new Response(pageHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        if (path === "/__driver.js") return new Response(driver, { headers: { "content-type": "text/javascript" } });
        // Bundle output first, then the page's own files (css, images).
        for (const dir of [bundleDir, pageDir]) {
          if (!dir) continue;
          const file = resolve(dir, "." + decodeURIComponent(path));
          // WHY: no ../ escapes out of the served dirs.
          if (!file.startsWith(dir + sep)) return new Response("forbidden", { status: 403 });
          if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
        }
        return new Response("not found", { status: 404 });
      },
    });
    const pageUrl = `http://127.0.0.1:${server.port}/render.html?render`;
    console.log(
      `rendering ${partial ? `${opts.from}..${to}s` : `full ${duration}s`} @ ${fps} fps, ${width}x${height}` +
        `\n  entry   ${opts.entry}\n  browser ${browser}\n  page    ${pageUrl}`,
    );

    // 3. browser
    const profile = join(tmp, "profile");
    browserProc = Bun.spawn(
      [
        browser,
        "--headless=new",
        "--disable-gpu-sandbox",
        "--use-angle=swiftshader-webgl",
        "--enable-unsafe-swiftshader",
        `--window-size=${width},${height}`,
        "--force-device-scale-factor=1",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        pageUrl,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    let browserErr = "";
    (async () => {
      for await (const chunk of browserProc!.stderr as ReadableStream<Uint8Array>)
        browserErr = (browserErr + new TextDecoder().decode(chunk)).slice(-4000);
    })().catch(() => {});
    browserProc.exited.then((code) => {
      if (!cleaned) settle.fail(new Error(`browser exited early (code ${code}):\n${browserErr.trim().slice(-1500)}`));
    });

    const deadline = t0 + opts.timeoutMin * 60_000;
    const watchdog = setInterval(() => {
      const now = performance.now();
      if (now > deadline) settle.fail(new Error(`overall timeout (${opts.timeoutMin} min)`));
      else if (now - lastFrameAt > STALL_MS)
        settle.fail(new Error(`no progress for ${STALL_MS / 1000}s (${received}/${count} frames)`));
    }, 1000);
    lastFrameAt = performance.now(); // covers page load + filmReady too
    try {
      await finished;
    } finally {
      clearInterval(watchdog);
    }
    const renderSecs = (performance.now() - renderStart) / 1000;
    console.log(`rendered ${count} frames in ${renderSecs.toFixed(1)}s (${(count / renderSecs).toFixed(2)} frames/s)`);

    // browser no longer needed; close it before the (long) encode
    browserProc.kill("SIGTERM");
    await Promise.race([browserProc.exited, Bun.sleep(3000)]);
    if (browserProc.exitCode === null) browserProc.kill("SIGKILL");

    // 4. encode
    mkdirSync(OUT_DIR, { recursive: true });
    const suffix = partial ? `-part-${opts.from}-${to}` : "";
    if (opts.framesOnly) {
      const dest = join(OUT_DIR, `frames${suffix}`);
      rmSync(dest, { recursive: true, force: true });
      cpSync(framesDir, dest, { recursive: true });
      console.log(`frames -> ${dest} (${readdirSync(dest).length} files)`);
    } else {
      const mp4 = join(OUT_DIR, `${NAME}${suffix}.mp4`);
      const encStart = performance.now();
      const cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", String(fps), "-i", join(framesDir, "%05d.png")];
      if (opts.audio) {
        // WHY: seek the soundtrack to the slice start; apad + -shortest makes
        // the output exactly the video length even if the wav is short.
        if (first > 0) cmd.push("-ss", (first / fps).toFixed(4));
        cmd.push("-i", opts.audio);
      }
      cmd.push("-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps));
      if (opts.audio) cmd.push("-c:a", "aac", "-b:a", "192k", "-af", "apad", "-shortest");
      cmd.push("-movflags", "+faststart", mp4);
      console.log("encoding…");
      await run(cmd, "ffmpeg encode");
      console.log(`encoded in ${((performance.now() - encStart) / 1000).toFixed(1)}s`);
      console.log(`  ${mp4}  ${(statSync(mp4).size / 1e6).toFixed(2)} MB`);

      // Poster: straight from the lossless PNG for t=64s when that frame was
      // rendered; a slice without it gets a poster of its own first frame.
      const posterIdx = Math.round((NAME === "yon-reel" ? timeline.poster : POSTER_T) * fps) - first;
      const idx = posterIdx >= 0 && posterIdx < count ? posterIdx : 0;
      const jpg = join(OUT_DIR, `${NAME}${suffix}.jpg`);
      await run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
          "-i", join(framesDir, `${String(idx).padStart(5, "0")}.png`), "-q:v", "2", jpg],
        "ffmpeg poster",
      );
      console.log(`  ${jpg}  ${(statSync(jpg).size / 1e3).toFixed(0)} kB  (t=${((first + idx) / fps).toFixed(2)}s)`);
    }
    console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(`render-film: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
