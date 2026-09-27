import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText, isMac, type AppState, type RemoteStatus, type Update } from "../api";
import PairPhoneSheet from "./PairPhoneSheet";

interface Props {
  state: AppState;
  onChange: (s: AppState) => void;
  onUpdate: (u: Update) => void;
  onClose: () => void;
}

export default function SettingsSheet({ state, onChange, onUpdate, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(state.settings.device_name);
  const [port, setPort] = useState(String(state.settings.port));
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [checking, setChecking] = useState<"idle" | "busy" | "latest">("idle");
  const [relayUrl, setRelayUrl] = useState(state.settings.relay_url);
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

  async function toggleDock(enabled: boolean) {
    setError(null);
    try {
      const settings = await api.setShowInDock(enabled);
      onChange({ ...state, settings });
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

  async function forget(id: string) {
    setError(null);
    try {
      const settings = await api.untrust(id);
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function unpair(id: string) {
    setError(null);
    try {
      const settings = await api.unpairPhone(id);
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function setRemote(enabled: boolean) {
    setError(null);
    try {
      const settings = await api.setRemote(enabled, relayUrl);
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function toggleUpdates(enabled: boolean) {
    setError(null);
    try {
      const settings = await api.setCheckUpdates(enabled);
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function checkNow() {
    setError(null);
    setChecking("busy");
    try {
      const found = await api.checkUpdate();
      if (found) {
        onUpdate(found);
        onClose();
      } else {
        setChecking("latest");
      }
    } catch (err) {
      setChecking("idle");
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
        {isMac && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.show_in_dock}
              onChange={(e) => toggleDock(e.target.checked)}
            />
            <span>
              Show Yon in the Dock
              <span className="hint">When off, Yon lives in the menu bar only.</span>
            </span>
          </label>
        )}
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
        <div className="field">
          <span>Accept automatically from</span>
          {state.settings.trusted.length === 0 ? (
            <p className="hint">
              No devices yet. Tick "Always accept from this device" when someone sends you files.
            </p>
          ) : (
            <ul className="trusted">
              {state.settings.trusted.map((t) => (
                <li key={t.id}>
                  <span className="file-name">{t.name}</span>
                  <button type="button" className="link" onClick={() => forget(t.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="field">
          <span>Phones</span>
          {state.settings.phones.length === 0 ? (
            <p className="hint">Send photos from your phone to this computer. No app needed.</p>
          ) : (
            <ul className="trusted">
              {state.settings.phones.map((p) => (
                <li key={p.id}>
                  <span className="file-name">{p.name}</span>
                  <button type="button" className="link" onClick={() => unpair(p.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.settings.link_error && <p className="hint bad">{state.settings.link_error}</p>}
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.remote}
              onChange={(e) => setRemote(e.target.checked)}
            />
            <span>
              Reach from anywhere
              <span className="hint">
                Phones can send and receive away from this Wi-Fi, through a relay that only
                passes on encrypted data.
              </span>
            </span>
          </label>
          <input
            aria-label="Relay address"
            placeholder="wss://relay.example.com"
            value={relayUrl}
            spellCheck={false}
            onChange={(e) => setRelayUrl(e.target.value)}
            onBlur={() => relayUrl !== state.settings.relay_url && setRemote(state.settings.remote)}
          />
          {state.settings.remote && <RemoteLine status={state.settings.remote_status} />}
          <button type="button" className="quiet pair-button" onClick={() => setPairing(true)}>
            Pair a phone
          </button>
        </div>
        <div className="field">
          <span>Updates</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.check_updates}
              onChange={(e) => toggleUpdates(e.target.checked)}
            />
            <span>
              Check for updates automatically
              <span className="hint">Asks GitHub for the latest version. Nothing else is sent.</span>
            </span>
          </label>
          <div className="folder">
            <span className="hint">
              {checking === "latest"
                ? `Yon ${state.me.version} is the latest version.`
                : `This is Yon ${state.me.version}.`}
            </span>
            <button type="button" className="quiet" onClick={checkNow} disabled={checking === "busy"}>
              {checking === "busy" ? "Checking…" : "Check now"}
            </button>
          </div>
        </div>
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
      {pairing && (
        <PairPhoneSheet
          online={state.online_phones}
          onPaired={(settings) => onChange({ ...state, settings })}
          onClose={() => setPairing(false)}
        />
      )}
    </dialog>
  );
}

function RemoteLine({ status }: { status: RemoteStatus | null }) {
  if (!status) return <p className="hint">Starts when a phone is paired.</p>;
  if (status.state === "connected") return <p className="hint">Connected to the relay.</p>;
  if (status.state === "connecting") return <p className="hint">Connecting to the relay…</p>;
  return <p className="hint bad">Relay: {status.message}</p>;
}
