import { useEffect, useRef, useState } from "react";
import { formatBytes, type Incoming } from "../api";
import { fileRows, plural } from "../files";
import { initials } from "./DeviceOrbit";

interface Props {
  request: Incoming;
  onAnswer: (accept: boolean, trust: boolean) => void;
}

export default function IncomingDialog({ request, onAnswer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [trust, setTrust] = useState(false);
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
        onAnswer(false, false);
      }}
    >
      <div className="sender">
        <span className="avatar small" aria-hidden>
          <span className="initials">{initials(request.sender_name)}</span>
        </span>
        <div>
          <h2 id="incoming-title">{request.sender_name}</h2>
          <p className="hint">
            wants to send you {plural(n, "file")}, {formatBytes(request.total)}
          </p>
        </div>
      </div>
      <ul className="files">
        {fileRows(request.files).map((f, i) => (
          <li key={i}>
            <span className="file-name">
              {f.folder ? `${f.name}/` : f.name}
              {f.folder && <span className="hint"> {plural(f.count, "file")}</span>}
            </span>
            {f.renamed && (
              <span className="tag" title="Renamed so it's safe to save on this device">
                renamed
              </span>
            )}
            <span className="size">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      {request.sender_os === "web" ? (
        <p className="hint">
          <span className="tag">web link</span> Sent from a paired phone&apos;s browser. Less
          protected than the Yon app: only accept files you expect.
        </p>
      ) : (
        <p className="hint">
          Device code <span className="code">{request.short_fingerprint}</span>. Not sure it&apos;s
          them? Ask them to open Settings in Yon and compare.
        </p>
      )}
      <label className="toggle">
        <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
        <span>
          Always accept from this {request.sender_os === "web" ? "phone" : "device"}
          <span className="hint">
            {request.sender_os === "web"
              ? "Only this paired phone. You can remove it in Settings."
              : "Only this device code. You can remove it in Settings."}
          </span>
        </span>
      </label>
      <div className="actions">
        {/* WHY: focus starts here, not on "Always accept" (the first focusable
            element), so a stray Space can't trust a device, and Enter declines. */}
        <button type="button" className="quiet" autoFocus onClick={() => onAnswer(false, false)}>
          Decline
        </button>
        <button type="button" className="primary" onClick={() => onAnswer(true, trust)}>
          Accept
        </button>
      </div>
    </dialog>
  );
}
