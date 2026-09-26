import { useState, type FormEvent } from "react";
import { api, errorText, type AppState } from "../api";

interface Props {
  state: AppState;
  onChange: (s: AppState) => void;
}

export default function Settings({ state, onChange }: Props) {
  const [name, setName] = useState(state.settings.device_name);
  const [port, setPort] = useState(String(state.settings.port));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      const next = await api.updateSettings(name, Number(port));
      onChange(next);
      setMessage({ ok: true, text: "Saved" });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  }

  async function changeFolder() {
    setMessage(null);
    try {
      const settings = await api.pickSaveDir();
      onChange({ ...state, settings });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  }

  return (
    <form className="panel settings" onSubmit={save}>
      <label>
        Device name
        <input value={name} maxLength={63} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Port
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </label>
      <div className="field">
        <span>Save received files to</span>
        <div className="row">
          <code className="path">{state.settings.save_dir}</code>
          <button type="button" onClick={changeFolder}>
            Change…
          </button>
        </div>
      </div>
      <div className="row">
        <button type="submit" className="primary">
          Save
        </button>
        {message && (
          <span className={message.ok ? "muted" : "error"} role="status">
            {message.text}
          </span>
        )}
      </div>
      <p className="muted small">
        This device: <code className="fp">{state.me.short_fingerprint}</code> · listening on port{" "}
        {state.me.port}
      </p>
    </form>
  );
}
