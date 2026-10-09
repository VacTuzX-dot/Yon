// Pair a phone: which step comes next, and short labels for the phone animation.
// Spec: docs/superpowers/specs/2026-10-09-pair-phone-tutorial-design.md

/** "add": the phone already has the Yon icon; "new": first time on this phone. */
export type PairPath = "add" | "new";
export type PairStep = "pair" | "needs_remote" | "no_relay";

/** WHY: Add computer on the phone only accepts relay codes, so "add" needs
 * Reach from anywhere on, and that needs a relay address. */
export function nextPairStep(path: PairPath, s: { remote: boolean; effective_relay: string | null }): PairStep {
  if (path === "new") return "pair";
  if (!s.effective_relay) return "no_relay";
  return s.remote ? "pair" : "needs_remote";
}

/** Fits a name into the phone mock's narrow label. */
export function shortName(name: string, max = 18): string {
  const t = name.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
