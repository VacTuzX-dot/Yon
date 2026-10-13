// Pure helpers for the phone page's receive screen. No DOM access, so they are unit-tested (receive.test.ts).

export type Kind = "image" | "video" | "other";

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "3gp"]);

/** By MIME type first, then extension. Photos and videos go to "Save to Photos" on iOS. */
export function kindOf(name: string, type: string): Kind {
  const t = type.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  // WHY: Photos rejects SVG, so it goes to "Save to Files" whatever the MIME type says.
  if (t === "image/svg+xml" || ext === "svg") return "other";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

/** "Mac", or "Leo's iPhone via Mac" when a phone sent it through computer C. */
// WHY: "via" only when the sender is not the computer itself; a computer sending
// from itself has no relay to name.
export function sender(from: string, computer: string): string {
  return from === computer ? from : `${from} via ${computer}`;
}

/** iPhone and iPad, including iPadOS, which reports itself as "MacIntel" with touch points. */
export function isIOS(ua: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // WHY: real Macs have no touch screen, so touch points tell iPadOS apart.
  return platform === "MacIntel" && maxTouchPoints > 0;
}
