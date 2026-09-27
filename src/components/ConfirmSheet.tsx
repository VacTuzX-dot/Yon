import { useEffect, useRef } from "react";
import { formatBytes, type Device, type Selection } from "../api";

interface Props {
  device: Device;
  selection: Selection;
  onSend: () => void;
  onClose: () => void;
}

export default function ConfirmSheet({ device, selection, onSend, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const n = selection.files.length;

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="confirm-title">Send to {device.name}</h2>
      <ul className="files">
        {selection.files.map((f, i) => (
          <li key={i}>
            <span className="file-name">{f.name}</span>
            <span className="size">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      <p className="summary">
        {n} {n === 1 ? "file" : "files"}, {formatBytes(selection.total)}
      </p>
      <div className="actions">
        <button type="button" className="quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onSend} autoFocus>
          Send
        </button>
      </div>
    </dialog>
  );
}
