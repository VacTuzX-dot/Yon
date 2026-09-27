import { useEffect, useState } from "react";
import { api, errorText, on, type Update } from "../api";

interface Props {
  update: Update;
  onLater: () => void;
}

/** "A new version is ready" strip: Update downloads, verifies and restarts. */
export default function UpdateBar({ update, onLater }: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sub = on("update-progress", (p) => setProgress(p.total ? p.done / p.total : 0));
    return () => {
      sub.then((unlisten) => unlisten());
    };
  }, []);

  async function install() {
    setError(null);
    setProgress(0);
    try {
      await api.installUpdate(); // restarts the app on success
    } catch (e) {
      setProgress(null);
      setError(errorText(e));
    }
  }

  const busy = progress !== null;
  return (
    <div className="update-bar" role="status">
      <span className="update-text">
        {error
          ? error
          : busy
            ? `Updating to ${update.version}… ${Math.floor(progress * 100)}%`
            : `Yon ${update.version} is available.`}
      </span>
      {!busy && (
        <>
          <button type="button" className="link" onClick={onLater}>
            Later
          </button>
          <button type="button" className="primary small" onClick={install}>
            {error ? "Try again" : "Update"}
          </button>
        </>
      )}
    </div>
  );
}
