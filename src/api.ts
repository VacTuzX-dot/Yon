// Typed wrappers around the Rust commands and events (see src-tauri/src/app.rs).
// The UI never handles file-system paths — only ids, names and sizes.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Device {
  id: string;
  name: string;
  os: string;
  app: string;
  compatible: boolean;
  short_fingerprint: string;
}

export interface Settings {
  device_name: string;
  save_dir: string;
  port: number;
  close_to_tray: boolean;
}

export interface AppState {
  me: { name: string; short_fingerprint: string; port: number; port_fallback: boolean };
  settings: Settings;
  devices: Device[];
  discovery_error: string | null;
}

export interface FileInfo {
  name: string;
  size: number;
}

export interface Selection {
  id: number;
  files: FileInfo[];
  total: number;
}

export interface Incoming {
  id: number;
  sender_name: string;
  sender_os: string;
  short_fingerprint: string;
  files: (FileInfo & { renamed: boolean })[];
  total: number;
}

export interface Progress {
  id: number;
  done: number;
  total: number;
}

export type RecvOutcome =
  | "completed"
  | "declined"
  | "timed_out"
  | "cancelled_by_sender"
  | "cancelled"
  | "failed";

export interface RecvFinished {
  id: number;
  outcome: RecvOutcome;
  reason: string | null;
  saved: string[];
}

export type SendStatus =
  | { state: "connecting" }
  | { state: "waiting" }
  | { state: "transferring"; done: number; total: number };

export type SendOutcome =
  | { outcome: "completed" }
  | { outcome: "declined" }
  | { outcome: "busy" }
  | { outcome: "timed_out" }
  | { outcome: "incompatible" }
  | { outcome: "insufficient_space" }
  | { outcome: "cancelled"; by_receiver: boolean }
  | { outcome: "failed"; reason: string };

export const api = {
  getState: () => invoke<AppState>("get_state"),
  pickFiles: () => invoke<Selection | null>("pick_files"),
  clearSelection: (id: number) => invoke<void>("clear_selection", { id }),
  send: (selectionId: number, deviceId: string) =>
    invoke<number>("send", { selectionId, deviceId }),
  cancelSend: (id: number) => invoke<void>("cancel_send", { id }),
  respond: (id: number, accept: boolean) => invoke<void>("respond", { id, accept }),
  cancelReceive: (id: number) => invoke<void>("cancel_receive", { id }),
  reveal: (id: number) => invoke<void>("reveal", { id }),
  updateSettings: (deviceName: string, port: number) =>
    invoke<AppState>("update_settings", { deviceName, port }),
  pickSaveDir: () => invoke<Settings>("pick_save_dir"),
  setCloseToTray: (enabled: boolean) => invoke<Settings>("set_close_to_tray", { enabled }),
};

export interface Events {
  devices: Device[];
  incoming: Incoming;
  "recv-progress": Progress;
  "recv-finished": RecvFinished;
  "send-status": { id: number; status: SendStatus };
  "send-finished": { id: number; result: SendOutcome };
}

export function on<K extends keyof Events>(
  event: K,
  handler: (payload: Events[K]) => void,
): Promise<UnlistenFn> {
  return listen<Events[K]>(event, (e) => handler(e.payload));
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong";
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function sendOutcomeText(r: SendOutcome): string {
  switch (r.outcome) {
    case "completed":
      return "Sent";
    case "declined":
      return "Declined";
    case "busy":
      return "Busy with another transfer";
    case "timed_out":
      return "No answer";
    case "incompatible":
      return "Update Yon on both devices";
    case "insufficient_space":
      return "Not enough space on their device";
    case "cancelled":
      return r.by_receiver ? "They cancelled" : "Cancelled";
    case "failed":
      return `Couldn't send: ${r.reason}`;
  }
}

export function recvOutcomeText(r: RecvFinished): string {
  switch (r.outcome) {
    case "completed":
      return `Received ${r.saved.length} file${r.saved.length === 1 ? "" : "s"}`;
    case "declined":
      return "Declined";
    case "timed_out":
      return "Request expired";
    case "cancelled_by_sender":
      return "Cancelled by sender";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return `Couldn't receive: ${r.reason ?? "unknown error"}`;
  }
}

export const isMac = navigator.userAgent.includes("Mac");
export const fileManagerName = isMac ? "Finder" : "Explorer";
