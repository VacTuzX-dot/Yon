// Decodes one QR code from raw pixels. Runs in a dedicated Worker (ADR-004):
// no DOM, no localStorage, no network, and the page never sends it a pairing.
import jsQR from "jsqr";

// WHY: the DOM lib has no worker-scope types; declare only what this file uses.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  postMessage: (v: string | null) => void;
};

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

ctx.onmessage = (e) => {
  const { data, width, height } = (e.data ?? {}) as { data?: unknown; width?: unknown; height?: unknown };
  if (!(data instanceof Uint8ClampedArray) || !isPositiveInt(width) || !isPositiveInt(height) || data.length !== width * height * 4) {
    ctx.postMessage(null);
    return;
  }
  try {
    ctx.postMessage(jsQR(data, width, height)?.data ?? null);
  } catch {
    // WHY: a crafted or odd frame must not crash the worker; "no code" is the right answer.
    ctx.postMessage(null);
  }
};
