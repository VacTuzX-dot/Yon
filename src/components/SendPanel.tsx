import { formatBytes, type Selection } from "../api";

interface Props {
  selection: Selection | null;
  canSend: boolean;
  onPick: () => void;
  onClear: () => void;
  onSend: () => void;
}

export default function SendPanel({ selection, canSend, onPick, onClear, onSend }: Props) {
  return (
    <section className="panel">
      <div className="row">
        <button type="button" onClick={onPick}>
          {selection ? "Choose other files…" : "Choose files…"}
        </button>
        {selection && (
          <button type="button" className="ghost" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {selection && (
        <>
          <ul className="files">
            {selection.files.map((f, i) => (
              <li key={i}>
                <span className="file-name">{f.name}</span>
                <span className="muted">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            {selection.files.length} file{selection.files.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(selection.total)}
          </p>
        </>
      )}
      <button type="button" className="primary" disabled={!canSend} onClick={onSend}>
        Send
      </button>
    </section>
  );
}
