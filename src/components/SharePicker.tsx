import { useEffect, useRef } from "react";
import { formatBytes, type Device, type Selection } from "../api";
import { initials } from "./DeviceOrbit";

interface Props {
  selection: Selection;
  devices: Device[];
  onPick: (device: Device) => void;
  onClose: () => void;
}

/** Files arrived from the OS (Send to / Open With): choose where they go. */
export default function SharePicker({ selection, devices, onPick, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const n = selection.files.length;
  const usable = devices.filter((d) => d.compatible);

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
        Send {n === 1 ? selection.files[0].name : `${n} files`}
      </h2>
      <p className="summary">{formatBytes(selection.total)}</p>
      {usable.length === 0 ? (
        <p className="hint share-empty">Looking for devices… Open Yon on the other device.</p>
      ) : (
        <ul className="picker" aria-label="Send to">
          {usable.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d)}>
                <span className="avatar small" aria-hidden>
                  <span className="initials">{initials(d.name)}</span>
                </span>
                <span className="file-name">{d.name}</span>
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
