import { useCallback, useEffect, useState } from "react";
import {
  api,
  errorText,
  fileManagerName,
  formatBytes,
  on,
  recvOutcomeText,
  sendOutcomeText,
  type AppState,
  type Incoming,
  type RecvFinished,
  type Selection,
  type SendOutcome,
  type SendStatus,
} from "./api";
import DeviceList from "./components/DeviceList";
import IncomingDialog from "./components/IncomingDialog";
import SendPanel from "./components/SendPanel";
import Settings from "./components/Settings";

interface Outgoing {
  id: number;
  to: string;
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

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [tab, setTab] = useState<"send" | "settings">("send");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [receiving, setReceiving] = useState<Receiving[]>([]);

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
        setReceiving((list) =>
          list.some((r) => r.id === f.id)
            ? list.map((r) => (r.id === f.id ? { ...r, finished: f } : r))
            : list,
        );
      }),
      on("send-status", ({ id, status }) =>
        setOutgoing((list) => list.map((o) => (o.id === id ? { ...o, status } : o))),
      ),
      on("send-finished", ({ id, result }) =>
        setOutgoing((list) => list.map((o) => (o.id === id ? { ...o, result } : o))),
      ),
    ];
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const sel = await api.pickFiles();
      if (sel) {
        if (selection) api.clearSelection(selection.id);
        setSelection(sel);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, [selection]);

  const clear = useCallback(() => {
    if (selection) api.clearSelection(selection.id);
    setSelection(null);
  }, [selection]);

  const send = useCallback(async () => {
    if (!selection || !device || !state) return;
    setError(null);
    const to = state.devices.find((d) => d.id === device)?.name ?? "device";
    try {
      const id = await api.send(selection.id, device);
      setOutgoing((list) => [{ id, to, status: { state: "connecting" } }, ...list]);
    } catch (e) {
      setError(errorText(e));
    }
  }, [selection, device, state]);

  const answer = useCallback(
    (accept: boolean) => {
      if (!incoming) return;
      api.respond(incoming.id, accept);
      if (accept) {
        setReceiving((list) => [
          { id: incoming.id, from: incoming.sender_name, done: 0, total: incoming.total },
          ...list,
        ]);
      }
      setIncoming(null);
    },
    [incoming],
  );

  if (fatal) return <main className="app"><p className="notice error">{fatal}</p></main>;
  if (!state) return <main className="app"><p className="muted">Starting…</p></main>;

  const selectedOk = state.devices.some((d) => d.id === device && d.compatible);

  return (
    <main className="app">
      <header>
        <h1>Yon</h1>
        <span className="muted">
          {state.me.name} · <code className="fp">{state.me.short_fingerprint}</code>
        </span>
        <nav>
          <button
            type="button"
            className={tab === "send" ? "tab active" : "tab"}
            onClick={() => setTab("send")}
          >
            Send
          </button>
          <button
            type="button"
            className={tab === "settings" ? "tab active" : "tab"}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
        </nav>
      </header>

      {state.me.port_fallback && (
        <p className="notice">
          Port {state.settings.port} is busy — using port {state.me.port} instead.
        </p>
      )}
      {error && <p className="notice error">{error}</p>}

      {tab === "send" ? (
        <div className="grid">
          <section>
            <h2>Nearby devices</h2>
            <DeviceList
              devices={state.devices}
              selected={device}
              onSelect={setDevice}
              error={state.discovery_error}
            />
          </section>
          <section>
            <h2>Files</h2>
            <SendPanel
              selection={selection}
              canSend={!!selection && selectedOk}
              onPick={pick}
              onClear={clear}
              onSend={send}
            />
          </section>
        </div>
      ) : (
        <Settings key={state.settings.port} state={state} onChange={setState} />
      )}

      {(outgoing.length > 0 || receiving.length > 0) && (
        <section>
          <h2>Transfers</h2>
          <ul className="transfers">
            {receiving.map((r) => (
              <li key={`r${r.id}`}>
                <div className="row">
                  <span>From {r.from}</span>
                  <span className="muted">
                    {r.finished
                      ? recvOutcomeText(r.finished)
                      : `${formatBytes(r.done)} / ${formatBytes(r.total)}`}
                  </span>
                </div>
                {!r.finished && <progress max={r.total || 1} value={r.done} />}
                <div className="row end">
                  {!r.finished && (
                    <button type="button" onClick={() => api.cancelReceive(r.id)}>
                      Cancel
                    </button>
                  )}
                  {r.finished && r.finished.saved.length > 0 && (
                    <button
                      type="button"
                      onClick={() => api.reveal(r.id).catch((e) => setError(errorText(e)))}
                    >
                      Show in {fileManagerName}
                    </button>
                  )}
                  {r.finished && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setReceiving((l) => l.filter((x) => x.id !== r.id))}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </li>
            ))}
            {outgoing.map((o) => (
              <li key={`s${o.id}`}>
                <div className="row">
                  <span>To {o.to}</span>
                  <span className="muted">
                    {o.result ? sendOutcomeText(o.result) : statusText(o.status)}
                  </span>
                </div>
                {!o.result && o.status.state === "transferring" && (
                  <progress max={o.status.total || 1} value={o.status.done} />
                )}
                <div className="row end">
                  {o.result ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setOutgoing((l) => l.filter((x) => x.id !== o.id))}
                    >
                      Dismiss
                    </button>
                  ) : (
                    <button type="button" onClick={() => api.cancelSend(o.id)}>
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {incoming && <IncomingDialog key={incoming.id} request={incoming} onAnswer={answer} />}
    </main>
  );
}

function statusText(s: SendStatus): string {
  switch (s.state) {
    case "connecting":
      return "Connecting…";
    case "waiting":
      return "Waiting for the other device to accept…";
    case "transferring":
      return `${formatBytes(s.done)} / ${formatBytes(s.total)}`;
  }
}
