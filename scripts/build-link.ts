// Builds the Yon Link phone page twice:
// - src-tauri/link-dist/: served by the computer on the LAN (embedded with
//   include_str!, so `cargo build` needs this first). Its CSP comes from the
//   HTTP headers the computer sends (connect-src 'self').
// - site/: the same page for GitHub Pages, reaching computers through the
//   relay (ADR-003). CSP by <meta> allowing only wss: (and localhost for
//   testing), and Subresource Integrity on the script.
import { createHash } from "node:crypto";

const lan = "src-tauri/link-dist";
const site = "site";

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
await Bun.write(`${site}/index.html`, html);
await Bun.write(`${site}/link.js`, js);
await Bun.write(`${site}/link.css`, Bun.file("web/link.css"));
await Bun.write(`${site}/icon.png`, Bun.file("src-tauri/icons/128x128@2x.png"));
console.log(`Yon Link page built into ${lan}/ and ${site}/`);
