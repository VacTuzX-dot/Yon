import { useState } from "react";
import type { Device } from "../api";
import { group, isReady, kindOf, labels, matches, osName, type Kind } from "../devices";
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
  /** Device id → when files were last sent to it (this session). */
  recent: Record<string, number>;
  /** Device under files being dragged over the window. */
  dropTarget: string | null;
  onPick: (d: Device) => void;
  onCancel: (d: Device) => void;
  error: string | null;
}

/** From this many devices on, circles give way to a searchable list. */
const LIST_FROM = 5;

export function initials(name: string): string {
  const words = name.replace(/[-_.]/g, " ").split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Outline icon for the kind of device (laptop, desktop, phone). */
export function DeviceIcon({ kind }: { kind: Kind }) {
  return (
    <svg className="device-icon" viewBox="0 0 24 24" aria-hidden>
      {kind === "laptop" && (
        <>
          <rect x="4" y="5" width="16" height="11" rx="1.5" />
          <path d="M2 19h20" />
        </>
      )}
      {kind === "desktop" && (
        <>
          <rect x="3" y="4" width="18" height="12" rx="1.5" />
          <path d="M9 20h6M12 16v4" />
        </>
      )}
      {kind === "phone" && (
        <>
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M11 18h2" />
        </>
      )}
    </svg>
  );
}

/** Second line under a device name: what it is and what's happening. */
function statusOf(d: Device, a: DeviceActivity | undefined): { text: string; tone?: string } {
  if (!d.compatible) return { text: "Update Yon to connect" };
  if (a) return { text: a.label, tone: a.tone };
  if (d.os === "phone") {
    return { text: d.online ? "Phone · Yon open" : "Open Yon on it to receive" };
  }
  return { text: osName(d) };
}

export default function DeviceOrbit({
  devices,
  activity,
  recent,
  dropTarget,
  onPick,
  onCancel,
  error,
}: Props) {
  const [query, setQuery] = useState("");
  if (error) return <p className="hint bad">{error}</p>;

  if (devices.length === 0) {
    return (
      <div className="orbit">
        <div className="device">
          <span className="avatar searching" aria-hidden />
          <p className="hint">Open Yon on another computer on this Wi-Fi, or pair a phone.</p>
        </div>
      </div>
    );
  }

  const names = labels(devices);
  const { ready, waiting } = group(devices, recent);

  if (devices.length < LIST_FROM) {
    return (
      <ul className="orbit" aria-label="Nearby devices">
        {[...ready, ...waiting].map((d) => {
          const a = activity[d.id];
          const st = statusOf(d, a);
          return (
            <li
              key={d.id}
              className={`device${dropTarget === d.id ? " drop-target" : ""}`}
              data-device-id={d.id}
            >
              <button
                type="button"
                className="avatar"
                disabled={!d.compatible || a?.busy}
                onClick={() => onPick(d)}
                title={d.compatible ? `Send files to ${names[d.id]}` : "Needs a newer Yon on one side"}
                aria-label={`Send files to ${names[d.id]}`}
              >
                {a?.busy && <Ring progress={a.progress} />}
                <DeviceIcon kind={kindOf(d)} />
              </button>
              <span className="device-name">{names[d.id]}</span>
              <span className={`device-status${st.tone ? ` ${st.tone}` : ""}`} role={a ? "status" : undefined}>
                {st.text}
                {a?.busy && (
                  <button type="button" className="link" onClick={() => onCancel(d)}>
                    Cancel
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  const shown = (list: Device[]) => list.filter((d) => matches(d, names[d.id], query));
  const readyShown = shown(ready);
  const waitingShown = shown(waiting);

  const row = (d: Device) => {
    const a = activity[d.id];
    const st = statusOf(d, a);
    return (
      <li
        key={d.id}
        className={`device-row${dropTarget === d.id ? " drop-target" : ""}`}
        data-device-id={d.id}
      >
        <button
          type="button"
          className="row-main"
          disabled={!d.compatible || a?.busy}
          onClick={() => onPick(d)}
          aria-label={`Send files to ${names[d.id]}`}
        >
          <span className="avatar small" aria-hidden>
            {a?.busy && <Ring progress={a.progress} />}
            <DeviceIcon kind={kindOf(d)} />
          </span>
          <span className="row-text">
            <span className="device-name">{names[d.id]}</span>
            <span className={`row-status${st.tone ? ` ${st.tone}` : ""}`} role={a ? "status" : undefined}>
              {isReady(d) && <span className="dot" aria-hidden />}
              {st.text}
            </span>
          </span>
        </button>
        {a?.busy && (
          <button type="button" className="link" onClick={() => onCancel(d)}>
            Cancel
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="device-list">
      <input
        type="search"
        className="device-search"
        placeholder="Search devices"
        aria-label="Search devices"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {readyShown.length > 0 && (
        <section aria-label="Ready now">
          <h2 className="group-label">Ready now</h2>
          <ul>{readyShown.map(row)}</ul>
        </section>
      )}
      {waitingShown.length > 0 && (
        <section aria-label="Phones to open">
          <h2 className="group-label">Phones · open Yon on them to receive</h2>
          <ul className="waiting">{waitingShown.map(row)}</ul>
        </section>
      )}
      {readyShown.length + waitingShown.length === 0 && (
        <p className="hint">No device matches “{query.trim()}”.</p>
      )}
    </div>
  );
}
