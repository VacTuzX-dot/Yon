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
  /** Phones only: its Yon page is open right now. */
  online?: boolean;
}

export interface Settings {
  device_name: string;
  save_dir: string;
  port: number;
  close_to_tray: boolean;
  show_in_dock: boolean;
  check_updates: boolean;
  trusted: { id: string; name: string }[];
  phones: { id: string; name: string; created: number }[];
  /** Set when phones can't connect (Yon Link port busy). */
  link_error: string | null;
  /** Reach from anywhere (ADR-003). */
  remote: boolean;
  relay_url: string;
  remote_status: RemoteStatus | null;
}

export type RemoteStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "error"; message: string };

export interface Update {
  version: string;
  notes: string | null;
}

export interface Qr {
  url: string;
  size: number;
  path: string;
}

export interface Pairing {
  phone_id: string;
  qr: Qr;
  fallback: Qr | null;
  /** qr works on any network (relay); fallback is the home Wi-Fi link. */
  anywhere: boolean;
  settings: Settings;
}

export interface AppState {
  me: {
    name: string;
    short_fingerprint: string;
    port: number;
    port_fallback: boolean;
    version: string;
  };
  settings: Settings;
  devices: Device[];
  discovery_error: string | null;
  online_phones: string[];
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
  respond: (id: number, accept: boolean, trust = false) =>
    invoke<void>("respond", { id, accept, trust }),
  untrust: (id: string) => invoke<Settings>("untrust", { id }),
  cancelReceive: (id: number) => invoke<void>("cancel_receive", { id }),
  reveal: (id: number) => invoke<void>("reveal", { id }),
  forgetReceived: (id: number) => invoke<void>("forget_received", { id }),
  takeShared: () => invoke<Selection | null>("take_shared"),
  updateSettings: (deviceName: string, port: number) =>
    invoke<AppState>("update_settings", { deviceName, port }),
  pickSaveDir: () => invoke<Settings>("pick_save_dir"),
  setCloseToTray: (enabled: boolean) => invoke<Settings>("set_close_to_tray", { enabled }),
  setShowInDock: (enabled: boolean) => invoke<Settings>("set_show_in_dock", { enabled }),
  pairPhone: (name: string) => invoke<Pairing>("pair_phone", { name }),
  unpairPhone: (id: string) => invoke<Settings>("unpair_phone", { id }),
  checkUpdate: () => invoke<Update | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  setCheckUpdates: (enabled: boolean) => invoke<Settings>("set_check_updates", { enabled }),
  setRemote: (enabled: boolean, relayUrl: string) =>
    invoke<Settings>("set_remote", { enabled, relayUrl }),
};

export interface Events {
  devices: Device[];
  "phones-online": string[];
  incoming: Incoming;
  shared: null;
  "recv-started": { id: number; sender_name: string; total: number };
  "recv-progress": Progress;
  "recv-finished": RecvFinished;
  "send-status": { id: number; status: SendStatus };
  "send-finished": { id: number; result: SendOutcome };
  "update-available": Update;
  "update-progress": { done: number; total: number | null };
  "remote-status": RemoteStatus;
}

export function on<K extends keyof Events>(
  event: K,
  handler: (payload: Events[K]) => void,
): Promise<UnlistenFn> {
  return listen<Events[K]>(event, (e) => handler(e.payload));
}

/** Computers found nearby plus paired phones (sent to over Yon Link). */
export function allDevices(state: AppState): Device[] {
  const phones: Device[] = state.settings.phones.map((p) => ({
    id: `phone:${p.id}`,
    name: p.name,
    os: "phone",
    app: "",
    compatible: true,
    short_fingerprint: "",
    online: state.online_phones.includes(p.id),
  }));
  return [...state.devices, ...phones];
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
// Windows may hand this to Directory Opus, Files, etc. — don't promise Explorer.
export const fileManagerName = isMac ? "Finder" : "folder";
