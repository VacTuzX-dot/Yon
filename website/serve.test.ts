import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { Server } from "bun";
import { CSP_PHONE, CSP_SITE, startSite } from "./serve";

let dir = "";
let secret = "";
let server: Server;
let base = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "yon-site-"));
  secret = mkdtempSync(join(tmpdir(), "yon-secret-"));
  writeFileSync(join(secret, "passwd"), "root:x:0:0\n");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Yon</title>");
  writeFileSync(join(dir, "home.css"), "body{}");
  writeFileSync(join(dir, "home.js"), "void 0;");
  writeFileSync(join(dir, "icon.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "toss.wav"), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
  writeFileSync(join(dir, "pwsh.ps1"), "Write-Host hi\n");
  writeFileSync(join(dir, "toss.mp3"), new Uint8Array([0x49, 0x44, 0x33]));
  writeFileSync(join(dir, "logo.svg"), "<svg/>");
  writeFileSync(join(dir, "favicon.ico"), new Uint8Array([0, 0, 1, 0]));
  writeFileSync(join(dir, "robots.txt"), "User-agent: *\n");
  writeFileSync(join(dir, "data.json"), "{}");
  writeFileSync(join(dir, ".env"), "SECRET=1"); // dotfile: never served
  writeFileSync(join(dir, "notes.md"), "x"); // unknown type: never served
  symlinkSync(join(secret, "passwd"), join(dir, "passwd.txt")); // symlink: never followed
  mkdirSync(join(dir, "phonelink"));
  writeFileSync(join(dir, "phonelink", "index.html"), "<!doctype html><title>Yon Link</title>");
  writeFileSync(join(dir, "phonelink", "link.js"), "void 1;");
  writeFileSync(join(dir, "phonelink", "link.css"), "p{}");
  server = startSite(0, dir);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(secret, { recursive: true, force: true });
});

/** Sends the path byte-for-byte (fetch would normalize "/../" away first). */
function raw(path: string, method = "GET"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(server.port!, "127.0.0.1", () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d.toString("latin1")));
    sock.on("end", () => resolve({ status: Number(data.split(" ")[1]), text: data }));
    sock.on("error", reject);
  });
}

test("serves / with the site CSP", async () => {
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>Yon</title>");
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("content-security-policy")).toBe(CSP_SITE);
  expect(CSP_SITE).toContain("media-src 'self'");
  expect(CSP_SITE).toContain("default-src 'none'");
});

test("serves /phonelink/ with the phone CSP", async () => {
  for (const path of ["/phonelink/", "/phonelink/index.html", "/phonelink/link.js"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(CSP_PHONE);
  }
  const res = await fetch(`${base}/phonelink/`);
  expect(await res.text()).toContain("<title>Yon Link</title>");
  expect(CSP_PHONE).toContain("connect-src wss:;");
  expect(CSP_PHONE).not.toContain("media-src");
});

test("/phonelink redirects to /phonelink/", async () => {
  const res = await fetch(`${base}/phonelink`, { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("/phonelink/");
});

test("path traversal and encoded paths are 404", async () => {
  for (const path of [
    "/../etc/passwd",
    "/../../../../etc/passwd",
    "/phonelink/..%2f..%2findex.html",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/phonelink%2findex.html",
    "/index.html%00",
    "//etc/passwd",
    "/home.js/",
  ]) {
    const res = await raw(path);
    expect(res.status, path).toBe(404);
    expect(res.text).not.toContain("root:");
  }
});

test("dot segments collapse like a browser's, never past the whitelist", async () => {
  // WHY: URL parsing resolves "/phonelink/../index.html" (and "%2e%2e") to "/index.html" — a
  // file that is public anyway. Nothing outside the whitelist is reachable.
  for (const path of ["/phonelink/../index.html", "/phonelink/%2e%2e/index.html"]) {
    const res = await raw(path);
    expect(res.status, path).toBe(200);
    expect(res.text).toContain("<title>Yon</title>");
  }
});

test("dotfiles, symlinks and unknown types are not served", async () => {
  for (const path of ["/.env", "/passwd.txt", "/notes.md"]) {
    expect((await fetch(`${base}${path}`)).status, path).toBe(404);
  }
});

test("unknown path is a plain-text 404 with security headers", async () => {
  const res = await fetch(`${base}/nope`);
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(res.headers.get("content-security-policy")).toBe(CSP_SITE);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("HEAD has headers and no body", async () => {
  const res = await fetch(`${base}/`, { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await res.text()).toBe("");
  const r = await raw("/", "HEAD");
  expect(r.status).toBe(200);
  expect(r.text.split("\r\n\r\n")[1]).toBe("");
});

test("other methods are 405 with Allow", async () => {
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const res = await fetch(`${base}/`, { method });
    expect(res.status, method).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  }
});

test("/healthz is ok", async () => {
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("security headers on every response", async () => {
  const expected = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cache-control": "no-cache",
  };
  const responses = [
    await fetch(`${base}/`),
    await fetch(`${base}/phonelink/`),
    await fetch(`${base}/phonelink`, { redirect: "manual" }),
    await fetch(`${base}/missing`),
    await fetch(`${base}/`, { method: "POST" }),
    await fetch(`${base}/healthz`),
  ];
  for (const res of responses) {
    for (const [k, v] of Object.entries(expected)) expect(res.headers.get(k), `${res.url} ${k}`).toBe(v);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
});

test("content types", async () => {
  const types: Record<string, string> = {
    "/index.html": "text/html; charset=utf-8",
    "/home.css": "text/css; charset=utf-8",
    "/home.js": "text/javascript; charset=utf-8",
    "/icon.png": "image/png",
    "/logo.svg": "image/svg+xml; charset=utf-8",
    "/favicon.ico": "image/x-icon",
    "/robots.txt": "text/plain; charset=utf-8",
    "/data.json": "application/json; charset=utf-8",
    "/toss.wav": "audio/wav",
    "/toss.mp3": "audio/mpeg",
    "/phonelink/link.css": "text/css; charset=utf-8",
  };
  for (const [path, type] of Object.entries(types)) {
    const res = await fetch(`${base}${path}`);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type"), path).toBe(type);
  }
  const wav = await fetch(`${base}/toss.wav`);
  expect(wav.headers.get("content-security-policy")).toBe(CSP_SITE);
  expect(new Uint8Array(await wav.arrayBuffer())).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
});

test("ETag revalidation returns 304", async () => {
  const first = await fetch(`${base}/home.js`);
  const etag = first.headers.get("etag")!;
  expect(etag).toBeTruthy();
  const again = await fetch(`${base}/home.js`, { headers: { "If-None-Match": etag } });
  expect(again.status).toBe(304);
  expect(again.headers.get("x-frame-options")).toBe("DENY");
});

test("Range: 206 with Content-Range, suffix ranges, 416 out of bounds, full body without Range", async () => {
  const full = await fetch(`${base}/toss.wav`);
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.status).toBe(200);

  const mid = await fetch(`${base}/toss.wav`, { headers: { Range: "bytes=1-2" } });
  expect(mid.status).toBe(206);
  expect(mid.headers.get("content-range")).toBe("bytes 1-2/4");
  expect(mid.headers.get("content-length")).toBe("2");
  expect(new Uint8Array(await mid.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x46]));
  expect(mid.headers.get("content-security-policy")).toBe(CSP_SITE);

  const open = await fetch(`${base}/toss.wav`, { headers: { Range: "bytes=2-" } });
  expect(open.headers.get("content-range")).toBe("bytes 2-3/4");

  const tail = await fetch(`${base}/toss.wav`, { headers: { Range: "bytes=-1" } });
  expect(tail.headers.get("content-range")).toBe("bytes 3-3/4");

  const past = await fetch(`${base}/toss.wav`, { headers: { Range: "bytes=9-" } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe("bytes */4");

  const junk = await fetch(`${base}/toss.wav`, { headers: { Range: "bytes=0-1,3-3" } });
  expect(junk.status).toBe(200); // multi-range: ignored, the whole file is valid
});

test("/pwsh serves the PowerShell installer as plain text, same as /pwsh.ps1", async () => {
  const short = await fetch(`${base}/pwsh`);
  const long = await fetch(`${base}/pwsh.ps1`);
  expect(short.status).toBe(200);
  expect(short.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(short.headers.get("x-content-type-options")).toBe("nosniff");
  expect(short.headers.get("content-security-policy")).toBe(CSP_SITE);
  expect(await short.text()).toBe(await long.text());
});
