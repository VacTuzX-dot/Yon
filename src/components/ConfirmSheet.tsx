import { useEffect, useRef } from "react";
import { formatBytes, type Device, type Selection } from "../api";
import { fileRows, plural } from "../files";

interface Props {
  device: Device;
  selection: Selection;
  onSend: () => void;
  /** Pick more files (or folders) to go along. */
  onAdd: (folders: boolean) => void;
  onClose: () => void;
}

export default function ConfirmSheet({ device, selection, onSend, onAdd, onClose }: Props) {
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
        {fileRows(selection.files).map((f, i) => (
          <li key={i}>
            <span className="file-name">
              {f.folder ? `${f.name}/` : f.name}
              {f.folder && <span className="hint"> {plural(f.count, "file")}</span>}
            </span>
            <span className="size">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      <div className="add-more">
        <button type="button" className="link" onClick={() => onAdd(false)}>
          Add files
        </button>
        <button type="button" className="link" onClick={() => onAdd(true)}>
          Add a folder
        </button>
      </div>
      <p className="summary">
        {plural(n, "file")}, {formatBytes(selection.total)}
      </p>
      {!device.folders && selection.files.some((f) => f.dir) && (
        <p className="hint">
          {device.os === "phone"
            ? "Phones get the files without their folders."
            : `${device.name} runs an older Yon, so the files arrive without their folders. Update Yon there to keep them.`}
        </p>
      )}
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
