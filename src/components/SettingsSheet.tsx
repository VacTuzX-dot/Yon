import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText, isMac, type AppState, type RemoteStatus, type Update } from "../api";
import PairPhoneSheet from "./PairPhoneSheet";

/** "wss://relay.example.com" → "relay.example.com" */
const hostOf = (url: string) => url.replace(/^wss?:\/\//, "");

interface Props {
  state: AppState;
  onChange: (s: AppState) => void;
  onUpdate: (u: Update) => void;
  onClose: () => void;
}

/** Every change saves on its own (fields when they lose focus), so there is
 *  one way out — Done — and nothing typed is ever lost by closing. */
export default function SettingsSheet({ state, onChange, onUpdate, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(state.settings.device_name);
  const [port, setPort] = useState(String(state.settings.port));
  const [basicsError, setBasicsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ replace?: { id: string; name: string } } | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [checking, setChecking] = useState<"idle" | "busy" | "latest">("idle");
  const [relayUrl, setRelayUrl] = useState(state.settings.relay_url);
  useEffect(() => ref.current?.showModal(), []);

  /** Save name and port if they changed. Returns false when they're invalid. */
  async function saveBasics(): Promise<boolean> {
    if (name.trim() === state.settings.device_name && Number(port) === state.settings.port) {
      return true;
    }
    setBasicsError(null);
    try {
      onChange(await api.updateSettings(name, Number(port)));
      return true;
    } catch (err) {
      setBasicsError(errorText(err));
      return false;
    }
  }

  async function close() {
    if (await saveBasics()) onClose();
  }

  /** Run a setting that saves at once, and show its result or error. */
  async function run(action: () => Promise<AppState["settings"]>) {
    setError(null);
    try {
      const settings = await action();
      onChange({ ...state, settings });
    } catch (err) {
      setError(errorText(err));
    }
  }

  // Saved when the field loses focus; a bad address keeps the old one.
  async function saveRelay() {
    if (relayUrl.trim() === state.settings.relay_url) return;
    setRelayError(null);
    try {
      const settings = await api.setRemote(state.settings.remote, relayUrl);
      setRelayUrl(settings.relay_url);
      onChange({ ...state, settings });
    } catch (err) {
      setRelayError(errorText(err));
      setRelayUrl(state.settings.relay_url);
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

  const phones = state.settings.phones.filter((p) => !p.pending);
  const relay = state.settings.effective_relay;

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault();
        void close();
      }}
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void saveBasics();
        }}
      >
        <h2 id="settings-title">Settings</h2>

        <section className="group" aria-labelledby="g-computer">
          <h3 id="g-computer">This computer</h3>
          <label className="field">
            <span>Name other devices see</span>
            <input
              value={name}
              maxLength={63}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveBasics()}
            />
          </label>
          {basicsError && <p className="hint bad">{basicsError}</p>}
          {isMac ? (
            <label className="toggle">
              <input
                type="checkbox"
                checked={state.settings.show_in_dock}
                onChange={(e) => run(() => api.setShowInDock(e.target.checked))}
              />
              <span>
                Show Yon in the Dock
                <span className="hint">When off, Yon lives in the menu bar only.</span>
              </span>
            </label>
          ) : (
            <label className="toggle">
              <input
                type="checkbox"
                checked={state.settings.close_to_tray}
                onChange={(e) => run(() => api.setCloseToTray(e.target.checked))}
              />
              <span>
                Keep running in the tray when closed
                <span className="hint">So nearby devices can still send you files.</span>
              </span>
            </label>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.launch_at_login}
              onChange={(e) => run(() => api.setLaunchAtLogin(e.target.checked))}
            />
            <span>
              Open Yon when I log in
              <span className="hint">
                Starts hidden in the {isMac ? "menu bar" : "tray"}, so nearby devices can send you files
                after a restart.
              </span>
            </span>
          </label>
          <p className="hint">
            Device code <span className="code">{state.me.short_fingerprint}</span>. People sending to
            you can check it matches.
          </p>
        </section>

        <section className="group" aria-labelledby="g-receiving">
          <h3 id="g-receiving">Receiving</h3>
          <div className="field">
            <span>Save files to</span>
            <div className="folder">
              <span className="path" title={state.settings.save_dir}>
                {state.settings.save_dir}
              </span>
              <button type="button" className="quiet" onClick={() => run(api.pickSaveDir)}>
                Change
              </button>
            </div>
          </div>
          <div className="field">
            <span>Accept without asking</span>
            {state.settings.trusted.length === 0 ? (
              <p className="hint">
                No devices yet. Tick "Always accept from this device" when someone sends you files.
              </p>
            ) : (
              <ul className="trusted">
                {state.settings.trusted.map((t) => (
                  <li key={t.id}>
                    <span className="file-name">{t.name}</span>
                    <button type="button" className="link" onClick={() => run(() => api.untrust(t.id))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="group" aria-labelledby="g-phones">
          <h3 id="g-phones">Phones</h3>
          {phones.length === 0 ? (
            <p className="hint">Send photos from your phone to this computer. No app needed.</p>
          ) : (
            <ul className="trusted">
              {phones.map((p) => (
                <li key={p.id}>
                  <span className="file-name">
                    {p.name}
                    {p.note === "home_only" && <span className="hint"> Home Wi-Fi only</span>}
                    {p.note === "needs_remote" && (
                      <span className="hint"> Needs Reach from anywhere</span>
                    )}
                  </span>
                  {p.note === "home_only" && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => setPairing({ replace: { id: p.id, name: p.name } })}
                    >
                      Pair again
                    </button>
                  )}
                  <button
                    type="button"
                    className="link"
                    onClick={() => run(() => api.unpairPhone(p.id))}
                  >
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
              disabled={!state.settings.remote && !relay}
              onChange={(e) => run(() => api.setRemote(e.target.checked, state.settings.relay_url))}
            />
            <span>
              Reach from anywhere
              <span className="hint">
                {relay
                  ? `Phones connect on any network, through ${hostOf(relay)}. Files stay encrypted.`
                  : "Add a relay address under Advanced to turn this on."}
              </span>
            </span>
          </label>
          {relay && (
            <details className="more">
              <summary>What the relay can see</summary>
              <p className="hint">
                Internet addresses, when devices connect, and how much they send. Never the files
                or their names.
              </p>
            </details>
          )}
          {state.settings.remote && <RemoteLine status={state.settings.remote_status} />}
          <button type="button" className="quiet pair-button" onClick={() => setPairing({})}>
            Pair a phone
          </button>
        </section>

        <section className="group" aria-labelledby="g-updates">
          <h3 id="g-updates">Updates</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.settings.check_updates}
              onChange={(e) => run(() => api.setCheckUpdates(e.target.checked))}
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
        </section>

        <details className="group">
          <summary>Advanced</summary>
          <label className="field">
            <span>Port</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onBlur={() => void saveBasics()}
            />
          </label>
          <p className="hint">
            Now listening on port {state.me.port}
            {state.me.port_fallback ? ` (${state.settings.port} was in use)` : ""}.
          </p>
          <label className="field">
            <span>Relay address</span>
            <input
              placeholder={
                state.settings.default_relay
                  ? hostOf(state.settings.default_relay)
                  : "wss://relay.example.com"
              }
              value={relayUrl}
              spellCheck={false}
              onChange={(e) => setRelayUrl(e.target.value)}
              onBlur={saveRelay}
            />
          </label>
          <p className={relayError ? "hint bad" : "hint"}>
            {relayError ??
              (state.settings.default_relay
                ? "Leave empty to use the built-in relay."
                : "Required to turn on Reach from anywhere.")}
          </p>
        </details>

        {error && <p className="hint bad">{error}</p>}
        <div className="actions">
          <button type="button" className="primary" onClick={() => void close()}>
            Done
          </button>
        </div>
      </form>
      {pairing && (
        <PairPhoneSheet
          online={state.online_phones}
          phones={state.settings.phones}
          replace={pairing.replace}
          onPaired={(settings) => onChange({ ...state, settings })}
          onClose={() => setPairing(null)}
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
