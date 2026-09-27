import { useEffect, useRef } from "react";
import { formatBytes, type Incoming } from "../api";
import { initials } from "./DeviceOrbit";

interface Props {
  request: Incoming;
  onAnswer: (accept: boolean) => void;
}

export default function IncomingDialog({ request, onAnswer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const n = request.files.length;

  return (
    <dialog
      ref={ref}
      className="sheet incoming"
      aria-labelledby="incoming-title"
      // Esc = decline, never a silent accept.
      onCancel={(e) => {
        e.preventDefault();
        onAnswer(false);
      }}
    >
      <div className="sender">
        <span className="avatar small" aria-hidden>
          <span className="initials">{initials(request.sender_name)}</span>
        </span>
        <div>
          <h2 id="incoming-title">{request.sender_name}</h2>
          <p className="hint">
            wants to send you {n} {n === 1 ? "file" : "files"}, {formatBytes(request.total)}
          </p>
        </div>
      </div>
      <ul className="files">
        {request.files.map((f, i) => (
          <li key={i}>
            <span className="file-name">{f.name}</span>
            {f.renamed && (
              <span className="tag" title="Renamed so it's safe to save on this device">
                renamed
              </span>
            )}
            <span className="size">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Device code <span className="code">{request.short_fingerprint}</span>. Not sure it's
        them? Ask them to open Settings in Yon and compare.
      </p>
      <div className="actions">
        <button type="button" className="quiet" onClick={() => onAnswer(false)}>
          Decline
        </button>
        <button type="button" className="primary" onClick={() => onAnswer(true)}>
          Accept
        </button>
      </div>
    </dialog>
  );
}
