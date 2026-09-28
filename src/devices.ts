// Ordering and labels for the device picker. Pure, so it can be tested
// without React.
import type { Device } from "./api";

export type Kind = "laptop" | "desktop" | "phone";

export function kindOf(d: Device): Kind {
  if (d.os === "macos") return "laptop";
  if (d.os === "phone" || d.os === "ios" || d.os === "android") return "phone";
  return "desktop";
}

const OS_NAMES: Record<string, string> = {
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
  ios: "iPhone or iPad",
  android: "Android",
  phone: "Phone",
};

export function osName(d: Device): string {
  return OS_NAMES[d.os] ?? "Computer";
}

/** Can take files right now: a computer running a compatible Yon, or a
 *  phone whose Yon page is open. */
export function isReady(d: Device): boolean {
  return d.compatible && (d.os !== "phone" || d.online === true);
}

/** Short code that tells apart devices with the same name. */
function codeOf(d: Device): string {
  const raw = d.short_fingerprint || d.id.replace(/^phone:/, "");
  return raw.replace(/[^0-9a-f]/gi, "").slice(0, 4).toUpperCase();
}

/** Display names; a name used by more than one device gets its code. */
export function labels(devices: Device[]): Record<string, string> {
  const count = new Map<string, number>();
  for (const d of devices) {
    const key = d.name.toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const d of devices) {
    const code = codeOf(d);
    out[d.id] = (count.get(d.name.toLowerCase()) ?? 0) > 1 && code ? `${d.name} · ${code}` : d.name;
  }
  return out;
}

/** Ready devices first, then phones that need Yon opened. Inside each group:
 *  most recently sent to first, then by name. */
export function group(
  devices: Device[],
  recent: Record<string, number>,
): { ready: Device[]; waiting: Device[] } {
  const byUse = (a: Device, b: Device) =>
    (recent[b.id] ?? 0) - (recent[a.id] ?? 0) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const sorted = [...devices].sort(byUse);
  return {
    ready: sorted.filter((d) => isReady(d) || !d.compatible),
    waiting: sorted.filter((d) => d.compatible && !isReady(d)),
  };
}

export function matches(d: Device, label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || label.toLowerCase().includes(q) || osName(d).toLowerCase().includes(q);
}
