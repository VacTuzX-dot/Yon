// Pure helpers for the ADR-005 PRF spike (spike.ts), kept apart so the entry
// bundle has no exports and loads as a classic script.

/** PRF output from getClientExtensionResults(), or null. Never trusts the shape. */
export function prfFirst(ext: unknown): Uint8Array<ArrayBuffer> | null {
  const first = (ext as { prf?: { results?: { first?: unknown } } } | null)?.prf?.results?.first;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  // WHY: copy, so the result is backed by a plain ArrayBuffer whatever the view sat on.
  if (ArrayBuffer.isView(first)) return new Uint8Array(new Uint8Array(first.buffer, first.byteOffset, first.byteLength));
  return null;
}

export function hex(b: Uint8Array, n = b.length): string {
  return Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, "0")).join("");
}
