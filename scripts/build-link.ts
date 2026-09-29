// Builds the Yon Link phone page twice:
// - src-tauri/link-dist/: served by the computer on the LAN (embedded with
//   include_str!, so `cargo build` needs this first). Its CSP comes from the
//   HTTP headers the computer sends (connect-src 'self').
// - site/: https://yon.meo.in.th (website/, served from our own server):
//   the project page at /, and the phone page at /phonelink/, reaching
//   computers through the relay (ADR-003). CSP by <meta> allowing only wss:
//   (and localhost for testing), and Subresource Integrity on the script;
//   website/serve.ts adds the same policy as HTTP headers.
// - site-pages/: what GitHub Pages serves at vactuzx-dot.github.io/Yon/ now:
//   a hand-off that sends phones paired there on to /phonelink/.
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";

const lan = "src-tauri/link-dist";
const site = "site";
const phone = `${site}/phonelink`;
const pages = "site-pages";
export const SITE = "https://yon.meo.in.th";
// WHY: start clean so nothing from an older layout gets deployed.
rmSync(site, { recursive: true, force: true });
rmSync(pages, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["web/link.ts"],
  outdir: lan,
  naming: "link.js",
  target: "browser",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const f of ["link.html", "link.css"]) await Bun.write(`${lan}/${f}`, Bun.file(`web/${f}`));

const js = await Bun.file(`${lan}/link.js`).arrayBuffer();
const sri = "sha384-" + createHash("sha384").update(new Uint8Array(js)).digest("base64");
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src wss: ws://localhost:* ws://127.0.0.1:*; base-uri 'none'; form-action 'none'";
const html = (await Bun.file("web/link.html").text())
  .replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
  .replace('<script src="link.js" defer></script>', `<script src="link.js" integrity="${sri}" defer></script>`);
if (!html.includes(sri) || !html.includes("Content-Security-Policy")) throw new Error("site page not patched");
const icon = Bun.file("src-tauri/icons/128x128@2x.png");
await Bun.write(`${phone}/index.html`, html);
await Bun.write(`${phone}/link.js`, js);
await Bun.write(`${phone}/link.css`, Bun.file("web/link.css"));
await Bun.write(`${phone}/icon.png`, icon);

for (const f of ["index.html", "home.css", "home.js", "toss.wav"]) await Bun.write(`${site}/${f}`, Bun.file(`web/home/${f}`));
// The film (web/film/): plain WebGL + an algorithmic soundtrack.
for (const f of ["index.html", "film.css", "film.mp3"]) await Bun.write(`${site}/film/${f}`, Bun.file(`web/film/${f}`));
const film = await Bun.build({ entrypoints: ["web/film/film.ts"], outdir: `${site}/film`, naming: "film.js", target: "browser", minify: true });
if (!film.success) {
  for (const log of film.logs) console.error(log);
  process.exit(1);
}
// The hero animation: plain WebGL, no dependencies (web/home/toss.ts).
const toss = await Bun.build({ entrypoints: ["web/home/toss.ts"], outdir: site, naming: "toss.js", target: "browser", minify: true });
if (!toss.success) {
  for (const log of toss.logs) console.error(log);
  process.exit(1);
}
await Bun.write(`${site}/icon.png`, icon);

// WHY: phones paired with the old address keep working, and the pairing key
// the old page cached in localStorage (on an origin every GitHub Pages
// project of this account shares) is removed on the way.
await Bun.write(
  `${pages}/index.html`,
  `<!doctype html>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-HASH'; base-uri 'none'" />
<meta name="referrer" content="no-referrer" />
<title>Yon has moved</title>
<p>Yon's phone page has moved to <a href="${SITE}/phonelink/">${SITE.replace("https://", "")}/phonelink</a>.</p>
<script>SCRIPT</script>
`,
);
const script = `try{localStorage.removeItem("yon-link-pairing")}catch(e){}location.replace("${SITE}/phonelink/"+location.hash);`;
const hash = createHash("sha256").update(script).digest("base64");
const redirect = (await Bun.file(`${pages}/index.html`).text()).replace("HASH", hash).replace("SCRIPT", script);
await Bun.write(`${pages}/index.html`, redirect);
console.log(`Yon Link page built into ${lan}/, ${phone}/ (with the project page in ${site}/) and ${pages}/`);
