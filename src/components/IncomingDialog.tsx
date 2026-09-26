import { useEffect, useRef } from "react";
import { formatBytes, type Incoming } from "../api";

interface Props {
  request: Incoming;
  onAnswer: (accept: boolean) => void;
}

export default function IncomingDialog({ request, onAnswer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="incoming"
      aria-labelledby="incoming-title"
      // Esc = decline, never a silent accept.
      onCancel={(e) => {
        e.preventDefault();
        onAnswer(false);
      }}
    >
      <h2 id="incoming-title">
        {request.sender_name} wants to send you {request.files.length} file
        {request.files.length === 1 ? "" : "s"}
      </h2>
      <p className="fp-line">
        Device fingerprint <code className="fp big">{request.short_fingerprint}</code>
      </p>
      <p className="muted small">
        Names can be faked. If you're unsure, check this fingerprint in Yon on the sender's
        device.
      </p>
      <ul className="files">
        {request.files.map((f, i) => (
          <li key={i}>
            <span className="file-name">{f.name}</span>
            {f.renamed && (
              <span className="badge" title="The name was changed to be safe on this device">
                renamed
              </span>
            )}
            <span className="muted">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      <p>Total {formatBytes(request.total)}</p>
      <div className="row end">
        <button type="button" onClick={() => onAnswer(false)}>
          Decline
        </button>
        <button type="button" className="primary" onClick={() => onAnswer(true)}>
          Accept
        </button>
      </div>
    </dialog>
  );
}
