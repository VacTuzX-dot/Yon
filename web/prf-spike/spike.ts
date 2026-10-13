// Throwaway device spike for ADR-005: does the WebAuthn PRF extension give the
// same secret in a Home Screen web app before and after the icon is deleted?
// No network, no storage: it shows a short hash of the PRF output, which the
// tester compares by eye. Remove with its build step before backup ships.
import { hex, prfFirst } from "./prf";

// WHY: its own salt and user name, so this passkey can never open a real backup record.
const SALT_LABEL = "yon-prf-spike-v1";
const USER_NAME = "Yon PRF test - delete me";

const $ = (id: string) => document.getElementById(id)!;

function log(line: string) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  $("log").append(li);
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

async function sha256(b: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const salt = () => sha256(new TextEncoder().encode(SALT_LABEL));

/** Logs the PRF result: a 16-hex fingerprint of SHA-256(output), never the output. */
async function report(step: string, ext: unknown) {
  const out = prfFirst(ext);
  const enabled = (ext as { prf?: { enabled?: unknown } } | null)?.prf?.enabled;
  if (!out) return log(`${step}: no PRF output (prf.enabled = ${String(enabled)})`);
  log(`${step}: PRF fingerprint ${hex(await sha256(out), 8)}  (${out.length} bytes)`);
}

async function create() {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: "Yon PRF test" },
        user: { id: random(16), name: USER_NAME, displayName: USER_NAME },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        // WHY: cast — the ES2020 DOM lib in tsconfig has no PRF types.
        extensions: { prf: { eval: { first: await salt() } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) return log("create: no credential");
    log(`create: passkey ${hex(new Uint8Array(cred.rawId), 6)}`);
    await report("create", cred.getClientExtensionResults());
  } catch (e) {
    log(`create failed: ${errText(e)}`);
  }
}

async function read() {
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        rpId: location.hostname,
        challenge: random(32),
        allowCredentials: [], // WHY: discoverable, like the real restore with empty storage
        userVerification: "required",
        extensions: { prf: { eval: { first: await salt() } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) return log("read: no credential");
    log(`read: passkey ${hex(new Uint8Array(cred.rawId), 6)}`);
    await report("read", cred.getClientExtensionResults());
  } catch (e) {
    log(`read failed: ${errText(e)}`);
  }
}

async function environment() {
  const standalone =
    matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  log(`mode: ${standalone ? "Home Screen app" : "browser tab"}`);
  log(`agent: ${navigator.userAgent}`);
  if (typeof PublicKeyCredential === "undefined") return log("WebAuthn: not available");
  const caps = (PublicKeyCredential as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
    .getClientCapabilities;
  if (!caps) return log("capabilities: getClientCapabilities not available");
  try {
    const c = await caps.call(PublicKeyCredential);
    log(`capabilities: extension:prf = ${String(c["extension:prf"])}, passkeyPlatformAuthenticator = ${String(c.passkeyPlatformAuthenticator)}`);
  } catch (e) {
    log(`capabilities failed: ${errText(e)}`);
  }
}

async function copy() {
  const text = Array.from($("log").children, (li) => li.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    log("copied");
  } catch (e) {
    log(`copy failed: ${errText(e)}`);
  }
}

$("create").addEventListener("click", () => void create());
$("read").addEventListener("click", () => void read());
$("copy").addEventListener("click", () => void copy());
void environment();
