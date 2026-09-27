import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorText,
  fileManagerName,
  formatBytes,
  on,
  recvOutcomeText,
  sendOutcomeText,
  type AppState,
  type Device,
  type Incoming,
  type RecvFinished,
  type Selection,
  type SendOutcome,
  type SendStatus,
} from "./api";
import ConfirmSheet from "./components/ConfirmSheet";
import DeviceOrbit, { initials, type DeviceActivity } from "./components/DeviceOrbit";
import IncomingDialog from "./components/IncomingDialog";
import Ring from "./components/Ring";
import SettingsSheet from "./components/SettingsSheet";

interface Outgoing {
  deviceId: string;
  status: SendStatus;
  result?: SendOutcome;
}

interface Receiving {
  id: number;
  from: string;
  done: number;
  total: number;
  finished?: RecvFinished;
}

/** How long a "Sent" / "Declined" note stays under a device. */
const NOTE_MS = 5000;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ device: Device; selection: Selection } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [outgoing, setOutgoing] = useState<Record<number, Outgoing>>({});
  const [receiving, setReceiving] = useState<Receiving[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    api.getState().then(setState, (e) => setFatal(errorText(e)));
    const subs = [
      on("devices", (devices) => setState((s) => (s ? { ...s, devices } : s))),
      on("incoming", (req) => setIncoming(req)),
      on("recv-progress", (p) =>
        setReceiving((list) =>
          list.map((r) => (r.id === p.id ? { ...r, done: p.done, total: p.total } : r)),
        ),
      ),
      on("recv-finished", (f) => {
        setIncoming((cur) => (cur?.id === f.id ? null : cur));
        setReceiving((list) => list.map((r) => (r.id === f.id ? { ...r, finished: f } : r)));
      }),
      on("send-status", ({ id, status }) =>
        setOutgoing((m) => (m[id] ? { ...m, [id]: { ...m[id], status } } : m)),
      ),
      on("send-finished", ({ id, result }) => {
        setOutgoing((m) => (m[id] ? { ...m, [id]: { ...m[id], result } } : m));
        // Good news fades; problems stay until the next try.
        if (["completed", "declined", "cancelled"].includes(result.outcome)) {
          timers.current.push(
            window.setTimeout(
              () =>
                setOutgoing((m) => {
                  const { [id]: _, ...rest } = m;
                  return rest;
                }),
              NOTE_MS,
            ),
          );
        }
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const pickFor = useCallback(async (device: Device) => {
    setError(null);
    try {
      const selection = await api.pickFiles();
      if (selection) setConfirm({ device, selection });
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const closeConfirm = useCallback(() => {
    if (confirm) api.clearSelection(confirm.selection.id);
    setConfirm(null);
  }, [confirm]);

  const send = useCallback(async () => {
    if (!confirm) return;
    const { device, selection } = confirm;
    setConfirm(null);
    try {
      const id = await api.send(selection.id, device.id);
      setOutgoing((m) => {
        // One note per device: drop the previous one for this device.
        const rest = Object.fromEntries(
          Object.entries(m).filter(([, o]) => o.deviceId !== device.id),
        );
        return { ...rest, [id]: { deviceId: device.id, status: { state: "connecting" } } };
      });
    } catch (e) {
      setError(errorText(e));
    }
  }, [confirm]);

  const answer = useCallback(
    (accept: boolean) => {
      if (!incoming) return;
      api.respond(incoming.id, accept);
      if (accept) {
        setReceiving((list) => [
          ...list,
          { id: incoming.id, from: incoming.sender_name, done: 0, total: incoming.total },
        ]);
      }
      setIncoming(null);
    },
    [incoming],
  );

  if (fatal) return <main className="app"><p className="hint bad">{fatal}</p></main>;
  if (!state) return <main className="app" />;

  const activity: Record<string, DeviceActivity> = {};
  for (const o of Object.values(outgoing)) {
    activity[o.deviceId] = toActivity(o);
  }
  const cancelFor = (d: Device) => {
    const entry = Object.entries(outgoing).find(([, o]) => o.deviceId === d.id && !o.result);
    if (entry) api.cancelSend(Number(entry[0]));
  };

  return (
    <main className="app">
      <header>
        <span className="wordmark">Yon</span>
        <button
          type="button"
          className="icon"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </button>
      </header>

      <section className="stage">
        <h1>{state.devices.length ? "Choose a device to send to" : "Looking for devices nearby"}</h1>
        <DeviceOrbit
          devices={state.devices}
          activity={activity}
          onPick={pickFor}
          onCancel={cancelFor}
          error={state.discovery_error}
        />
        {error && <p className="hint bad">{error}</p>}
      </section>

      {receiving.length > 0 && (
        <ul className="tray" aria-label="Incoming files">
          {receiving.map((r) => (
            <li key={r.id}>
              <span className="avatar small" aria-hidden>
                {!r.finished && <Ring progress={r.total ? r.done / r.total : null} />}
                <span className="initials">{initials(r.from)}</span>
              </span>
              <span className="tray-text">
                {r.finished
                  ? `${recvOutcomeText(r.finished)} from ${r.from}`
                  : `Receiving from ${r.from}, ${formatBytes(r.done)} of ${formatBytes(r.total)}`}
              </span>
              {!r.finished && (
                <button type="button" className="quiet" onClick={() => api.cancelReceive(r.id)}>
                  Cancel
                </button>
              )}
              {r.finished && r.finished.saved.length > 0 && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => api.reveal(r.id).catch((e) => setError(errorText(e)))}
                >
                  Show in {fileManagerName}
                </button>
              )}
              {r.finished && (
                <button
                  type="button"
                  className="icon small"
                  aria-label="Dismiss"
                  onClick={() => setReceiving((l) => l.filter((x) => x.id !== r.id))}
                >
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <footer>
        You appear as <strong>{state.me.name}</strong>
      </footer>

      {confirm && (
        <ConfirmSheet
          device={confirm.device}
          selection={confirm.selection}
          onSend={send}
          onClose={closeConfirm}
        />
      )}
      {settingsOpen && (
        <SettingsSheet state={state} onChange={setState} onClose={() => setSettingsOpen(false)} />
      )}
      {incoming && <IncomingDialog key={incoming.id} request={incoming} onAnswer={answer} />}
    </main>
  );
}

function toActivity(o: Outgoing): DeviceActivity {
  if (o.result) {
    const ok = o.result.outcome === "completed";
    const neutral = o.result.outcome === "declined" || o.result.outcome === "cancelled";
    return {
      progress: null,
      busy: false,
      label: sendOutcomeText(o.result),
      tone: ok ? "ok" : neutral ? undefined : "bad",
    };
  }
  switch (o.status.state) {
    case "connecting":
      return { progress: null, busy: true, label: "Connecting…" };
    case "waiting":
      return { progress: null, busy: true, label: "Waiting for them to accept…" };
    case "transferring": {
      const p = o.status.total ? o.status.done / o.status.total : 0;
      return { progress: p, busy: true, label: `${Math.floor(p * 100)}%` };
    }
  }
}
