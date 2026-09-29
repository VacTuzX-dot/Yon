/** One finished transfer in the Activity list (this session only). */
export interface ActivityEntry {
  /** Transfer id; for received files also the id `reveal` takes. */
  id: number;
  dir: "in" | "out";
  /** The other device. */
  who: string;
  /** "Received 3 files", "Declined", "Couldn't send: …". */
  text: string;
  tone?: "ok" | "bad";
  at: number;
  /** Received files are on disk and can be shown in the file manager. */
  canReveal?: boolean;
}

/** Keep as many as Rust remembers for "Show in Finder" (MAX_REMEMBERED). */
export const MAX_ACTIVITY = 50;

/** Newest first; one entry per transfer; capped. */
export function addEntry(list: ActivityEntry[], e: ActivityEntry): ActivityEntry[] {
  return [e, ...list.filter((x) => !(x.id === e.id && x.dir === e.dir))].slice(0, MAX_ACTIVITY);
}

/** "just now", "5 min ago", "2 h ago", then the time of day. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 12) return `${h} h ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
