import { useEffect, useRef } from "react";

interface Props {
  deviceName: string;
  onStop: () => void;
  onClose: () => void;
}

/** "Stop sending?" — cancelling throws away what's in flight, so ask first. */
export default function StopSheet({ deviceName, onStop, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="stop-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="stop-title">Stop sending to {deviceName}?</h2>
      <p className="hint">
        The file being sent is removed from {deviceName}. Files that already arrived stay there.
      </p>
      <div className="actions">
        <button type="button" className="quiet" onClick={onClose} autoFocus>
          Keep sending
        </button>
        <button type="button" className="danger" onClick={onStop}>
          Stop sending
        </button>
      </div>
    </dialog>
  );
}
