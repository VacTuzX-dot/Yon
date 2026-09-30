/** One finished transfer in the Activity list. */
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
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // Kept across restarts, so an older entry needs its day.
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const KEY = "yon-activity-v1";

/**
 * What is saved: who, what happened and when. Never a file name or path, so a
 * failure's reason (an OS error can name a file) is cut down to its first words.
 */
export function serialize(list: ActivityEntry[]): string {
  return JSON.stringify(
    list.slice(0, MAX_ACTIVITY).map(({ dir, who, text, tone, at }) => ({
      dir,
      who,
      text: text.replace(/^(Couldn't (?:send|receive)):[\s\S]*$/, "$1"),
      tone,
      at,
    })),
  );
}

/**
 * Saved text back into entries; anything malformed is dropped. Ids turn
 * negative so they can't meet this session's transfer ids, and nothing can be
 * shown in the file manager any more (Rust forgot the paths).
 */
export function restore(raw: string | null): ActivityEntry[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    const out: ActivityEntry[] = [];
    for (const x of list) {
      if (out.length >= MAX_ACTIVITY) break;
      if (!x || typeof x !== "object") continue;
      const { dir, who, text, tone, at } = x as Record<string, unknown>;
      if ((dir !== "in" && dir !== "out") || typeof who !== "string" || typeof text !== "string") continue;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      out.push({
        id: -(out.length + 1),
        dir,
        who: who.slice(0, 100),
        text: text.slice(0, 300),
        tone: tone === "ok" || tone === "bad" ? tone : undefined,
        at,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// localStorage can be missing or full; the list just isn't kept then.
export function loadActivity(): ActivityEntry[] {
  try {
    return restore(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveActivity(list: ActivityEntry[]): void {
  try {
    localStorage.setItem(KEY, serialize(list));
  } catch {
    // not kept
  }
}
