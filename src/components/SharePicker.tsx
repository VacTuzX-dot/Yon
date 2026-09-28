import { useEffect, useRef } from "react";
import { formatBytes, type Device, type Selection } from "../api";
import { fileRows, plural } from "../files";
import { group, kindOf, labels } from "../devices";
import { DeviceIcon } from "./DeviceOrbit";

interface Props {
  selection: Selection;
  devices: Device[];
  /** Device id → when files were last sent to it (this session). */
  recent: Record<string, number>;
  onPick: (device: Device) => void;
  onClose: () => void;
}

/** Files arrived from the OS (Send to / Open With): choose where they go. */
export default function SharePicker({ selection, devices, recent, onPick, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const n = selection.files.length;
  const rows = fileRows(selection.files);
  const usable = devices.filter((d) => d.compatible);
  const names = labels(usable);
  const { ready, waiting } = group(usable, recent);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="share-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="share-title">
        Send {rows.length === 1 && rows[0].count === n ? rows[0].name : plural(n, "file")}
      </h2>
      <p className="summary">{formatBytes(selection.total)}</p>
      {usable.length === 0 ? (
        <p className="hint share-empty">Looking for devices… Open Yon on the other device.</p>
      ) : (
        <ul className="picker" aria-label="Send to">
          {[...ready, ...waiting].map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d)}>
                <span className="avatar small" aria-hidden>
                  <DeviceIcon kind={kindOf(d)} />
                </span>
                <span className="file-name">{names[d.id]}</span>
                {waiting.includes(d) && <span className="hint">Open Yon on it</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
