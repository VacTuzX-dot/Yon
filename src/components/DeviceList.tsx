import type { Device } from "../api";

interface Props {
  devices: Device[];
  selected: string | null;
  onSelect: (id: string) => void;
  error: string | null;
}

const OS_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
};

export default function DeviceList({ devices, selected, onSelect, error }: Props) {
  if (error) return <p className="notice error">{error}</p>;
  if (devices.length === 0) {
    return (
      <p className="empty">
        Looking for nearby devices… Open Yon on another device on the same network.
      </p>
    );
  }
  return (
    <ul className="devices" role="listbox" aria-label="Nearby devices">
      {devices.map((d) => (
        <li key={d.id}>
          <button
            type="button"
            role="option"
            aria-selected={selected === d.id}
            className={`device${selected === d.id ? " selected" : ""}`}
            disabled={!d.compatible}
            onClick={() => onSelect(d.id)}
          >
            <span className="device-name">{d.name}</span>
            <span className="device-meta">
              {OS_LABEL[d.os] ?? d.os}
              {d.compatible ? "" : " · incompatible version"}
            </span>
            <code className="fp">{d.short_fingerprint}</code>
          </button>
        </li>
      ))}
    </ul>
  );
}
