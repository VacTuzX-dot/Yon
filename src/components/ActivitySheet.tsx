import { useEffect, useRef, useState } from "react";
import { fileManagerName } from "../api";
import { ago, type ActivityEntry } from "../activity";

interface Props {
  entries: ActivityEntry[];
  onReveal: (id: number) => void;
  onClear: () => void;
  onClose: () => void;
}

/** What was sent and received, newest first. */
export default function ActivitySheet({ entries, onReveal, onClear, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  // Re-render once a minute so "5 min ago" keeps up while the sheet is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="activity-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="activity-title">Activity</h2>
      {entries.length === 0 ? (
        <p className="hint">Files you send and receive show up here.</p>
      ) : (
        <ul className="activity">
          {entries.map((e) => (
            <li key={`${e.dir}${e.id}`}>
              <svg className={`activity-dir ${e.dir}`} viewBox="0 0 24 24" aria-hidden>
                {e.dir === "in" ? <path d="M17 7 7 17M7 9v8h8" /> : <path d="M7 17 17 7M9 7h8v8" />}
              </svg>
              <span className="activity-text">
                <span className="file-name">{e.who}</span>
                <span className={`hint ${e.tone ?? ""}`}>
                  {e.text} · {ago(e.at, now)}
                </span>
              </span>
              {e.canReveal && (
                <button type="button" className="link" onClick={() => onReveal(e.id)}>
                  Show in {fileManagerName}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Kept on this computer until you clear it. File names aren't saved.</p>
      <div className="actions">
        {entries.length > 0 && (
          <button type="button" className="quiet" onClick={onClear}>
            Clear
          </button>
        )}
        <button type="button" className="primary" onClick={onClose} autoFocus>
          Done
        </button>
      </div>
    </dialog>
  );
}
