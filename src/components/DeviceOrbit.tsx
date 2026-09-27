import type { Device } from "../api";
import Ring from "./Ring";

export interface DeviceActivity {
  /** 0..1, or null while connecting / waiting for the other side. */
  progress: number | null;
  label: string;
  busy: boolean;
  tone?: "ok" | "bad";
}

interface Props {
  devices: Device[];
  activity: Record<string, DeviceActivity | undefined>;
  onPick: (d: Device) => void;
  onCancel: (d: Device) => void;
  error: string | null;
}

export function initials(name: string): string {
  const words = name.replace(/[-_.]/g, " ").split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export default function DeviceOrbit({ devices, activity, onPick, onCancel, error }: Props) {
  if (error) return <p className="hint bad">{error}</p>;

  if (devices.length === 0) {
    return (
      <div className="orbit">
        <div className="device">
          <span className="avatar searching" aria-hidden />
          <p className="hint">Open Yon on another device on this Wi-Fi.</p>
        </div>
      </div>
    );
  }

  return (
    <ul className="orbit" aria-label="Nearby devices">
      {devices.map((d) => {
        const a = activity[d.id];
        return (
          <li key={d.id} className="device">
            <button
              type="button"
              className="avatar"
              disabled={!d.compatible || a?.busy}
              onClick={() => onPick(d)}
              title={d.compatible ? `Send files to ${d.name}` : "Needs a newer Yon on one side"}
              aria-label={`Send files to ${d.name}`}
            >
              {a?.busy && <Ring progress={a.progress} />}
              <span className="initials">{initials(d.name)}</span>
            </button>
            <span className="device-name">{d.name}</span>
            {!d.compatible ? (
              <span className="device-status">Update Yon to connect</span>
            ) : a ? (
              <span className={`device-status${a.tone ? ` ${a.tone}` : ""}`} role="status">
                {a.label}
                {a.busy && (
                  <button type="button" className="link" onClick={() => onCancel(d)}>
                    Cancel
                  </button>
                )}
              </span>
            ) : d.os === "phone" ? (
              <span className="device-status">
                {d.online ? "Phone" : "Phone · open Yon on it to receive"}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
