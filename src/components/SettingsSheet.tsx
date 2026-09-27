import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText, isMac, type AppState } from "../api";

interface Props {
  state: AppState;
  onChange: (s: AppState) => void;
  onClose: () => void;
}

export default function SettingsSheet({ state, onChange, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(state.settings.device_name);
  const [port, setPort] = useState(String(state.settings.port));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => ref.current?.showModal(), []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onChange(await api.updateSettings(name, Number(port)));
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function toggleTray(enabled: boolean) {
    setError(null);
    try {
      const settings = await api.setCloseToTray(enabled);
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function changeFolder() {
    setError(null);
    try {
      const settings = await api.pickSaveDir();
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={save}>
        <h2 id="settings-title">Settings</h2>
        <label className="field">
          <span>Device name</span>
          <input value={name} maxLength={63} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>Save files to</span>
          <div className="folder">
            <span className="path" title={state.settings.save_dir}>
              {state.settings.save_dir}
            </span>
            <button type="button" className="quiet" onClick={changeFolder}>
              Change
            </button>
          </div>
        </div>
        {!isMac && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.close_to_tray}
              onChange={(e) => toggleTray(e.target.checked)}
            />
            <span>
              Keep running in the tray when closed
              <span className="hint">So nearby devices can still send you files.</span>
            </span>
          </label>
        )}
        <details>
          <summary>Advanced</summary>
          <label className="field">
            <span>Port</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </label>
          <p className="hint">
            Now listening on port {state.me.port}
            {state.me.port_fallback ? ` (${state.settings.port} was in use)` : ""}.
          </p>
        </details>
        <p className="hint">
          Your device code is <span className="code">{state.me.short_fingerprint}</span>. People
          sending to you can check it matches.
        </p>
        {error && <p className="hint bad">{error}</p>}
        <div className="actions">
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
