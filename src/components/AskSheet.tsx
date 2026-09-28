import { useEffect, useRef } from "react";

interface Props {
  title: string;
  body: string;
  /** Label of the destructive button, e.g. "Stop sending", "Remove". */
  confirm: string;
  /** Label of the safe way out, e.g. "Keep sending", "Cancel". */
  keep: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** Asks before something that can't be undone (stop a send, remove a
 *  phone). The safe choice has focus, so Enter never destroys anything. */
export default function AskSheet({ title, body, confirm, keep, onConfirm, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="ask-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="ask-title">{title}</h2>
      <p className="hint">{body}</p>
      <div className="actions">
        <button type="button" className="quiet" onClick={onClose} autoFocus>
          {keep}
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
