// Static server for https://yon.meo.in.th (the `site/` that
// scripts/build-link.ts builds): the project page at / and the Yon Link phone
// page at /phonelink/. No dependencies beyond Bun itself.
//
// The phone page keeps a pairing key in its URL fragment and localStorage, so
// this origin runs no third-party code and every response carries a strict
// CSP. Deployed by .github/workflows/website.yml (website/deploy.sh), reached
// only through Cloudflare Tunnel (https://<SITE_HOST> → 127.0.0.1:8788).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "bun";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  ico: "image/x-icon",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

export const CSP_PHONE =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const CSP_SITE =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const COMMON: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-cache",
};

type Entry = { body: Uint8Array; type: string; etag: string };
type Site = { files: Map<string, Entry>; redirects: Map<string, string> };

// WHY: names that need no percent-encoding, so the request path is looked up
// as-is (never decoded) and a file name can't smuggle "/", "..", "%" or NUL.
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Walks `dir` once and returns the only URL paths this server will answer.
 *  Content is read into memory: the site is a few small files and never
 *  changes while the container runs (read-only image). */
export function loadSite(dir: string): Site {
  const files = new Map<string, Entry>();
  const redirects = new Map<string, string>();
  const walk = (abs: string, url: string) => {
    for (const name of readdirSync(abs).sort()) {
      const path = join(abs, name);
      const stat = lstatSync(path); // WHY: lstat — symlinks are never followed
      if (!SAFE_NAME.test(name)) {
        console.warn(`Skipping ${path}: name is not URL-safe`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, `${url}${name}/`);
        continue;
      }
      if (!stat.isFile()) {
        console.warn(`Skipping ${path}: not a regular file`);
        continue;
      }
      const type = TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
      if (!name.includes(".") || !type) {
        console.warn(`Skipping ${path}: unknown file type`);
        continue;
      }
      const body = new Uint8Array(readFileSync(path));
      const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
      const entry = { body, type, etag };
      files.set(url + name, entry);
      if (name === "index.html") {
        files.set(url, entry); // "/" and "/phonelink/"
        if (url !== "/") redirects.set(url.slice(0, -1), url); // "/phonelink" → "/phonelink/"
      }
    }
  };
  walk(dir, "/");
  return { files, redirects };
}

function headers(path: string, extra: Record<string, string>): Headers {
  const h = new Headers(COMMON);
  h.set("Content-Security-Policy", path.startsWith("/phonelink/") ? CSP_PHONE : CSP_SITE);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function text(path: string, status: number, body: string, head: boolean, extra: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  const h = headers(path, { "Content-Type": TYPES.txt, "Content-Length": String(bytes.length), ...extra });
  return new Response(head ? null : bytes, { status, headers: h });
}

export function handle(site: Site, req: Request): Response {
  // WHY: the raw pathname is only ever a map key — it is never decoded or
  // joined onto a file path, so "..", "%2e%2e", "%2f" etc. simply miss.
  const path = new URL(req.url).pathname;
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) {
    return text(path, 405, "Method Not Allowed\n", false, { Allow: "GET, HEAD" });
  }
  if (path === "/healthz") return text(path, 200, "ok", head);

  const target = site.redirects.get(path);
  if (target) return text(path, 301, "Moved Permanently\n", head, { Location: target });

  const file = site.files.get(path);
  if (!file) return text(path, 404, "Not Found\n", head);

  const extra = { "Content-Type": file.type, "Content-Length": String(file.body.length), ETag: file.etag };
  if (req.headers.get("If-None-Match") === file.etag) {
    return new Response(null, { status: 304, headers: headers(path, { ETag: file.etag }) });
  }
  return new Response(head ? null : file.body, { status: 200, headers: headers(path, extra) });
}

export function startSite(port: number, dir: string): Server {
  const site = loadSite(dir);
  if (!site.files.has("/")) throw new Error(`${dir} has no index.html`);
  return Bun.serve({
    port,
    fetch: (req) => handle(site, req),
    error: (err) => {
      console.error(err);
      return new Response("Internal Server Error\n", { status: 500, headers: headers("/", {}) });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8788);
  const server = startSite(port, join(import.meta.dir, "public"));
  console.log(`Yon site listening on :${server.port}`);
}
