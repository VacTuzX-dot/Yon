import { useCallback, useEffect, useRef, useState } from "react";
import {
  allDevices,
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
  type Update,
} from "./api";
import ConfirmSheet from "./components/ConfirmSheet";
import DeviceOrbit, { initials, type DeviceActivity } from "./components/DeviceOrbit";
import DropZone from "./components/DropZone";
import { labels } from "./devices";
import IncomingDialog from "./components/IncomingDialog";
import PairPhoneSheet from "./components/PairPhoneSheet";
import { LogoShapes } from "./components/Logo";
import Ring from "./components/Ring";
import SettingsSheet from "./components/SettingsSheet";
import SharePicker from "./components/SharePicker";
import AskSheet from "./components/AskSheet";
import ActivitySheet from "./components/ActivitySheet";
import { addEntry, loadActivity, saveActivity, type ActivityEntry } from "./activity";
import { plural } from "./files";
import type { MenuItem } from "./components/DeviceMenu";
import UpdateBar from "./components/UpdateBar";

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
/** How long a finished "Received …" toast stays; problems a little longer.
 *  Everything stays in Activity. */
const TOAST_MS = 6000;
const TOAST_PROBLEM_MS = 12000;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  /** Device id → when files were last sent to it; orders the picker. Not saved. */
  const [recent, setRecent] = useState<Record<string, number>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ device: Device; selection: Selection } | null>(null);
  const [shared, setShared] = useState<Selection | null>(null);
  const [pairing, setPairing] = useState(false);
  /** Content has scrolled under the header: it turns to glass only then. */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  /** Device whose send the user wants to stop; asks before cancelling. */
  const [stopping, setStopping] = useState<Device | null>(null);
  /** Phone the user asked to remove; asks before unpairing. */
  const [removing, setRemoving] = useState<Device | null>(null);
  /** Files are being dragged over the window; the device id under them, if any. */
  const [dragging, setDragging] = useState<{
    over: string | null;
    files: number;
    folders: number;
  } | null>(null);
  // Listeners are set up once; they read the latest device list from here.
  const devicesRef = useRef<Device[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [outgoing, setOutgoing] = useState<Record<number, Outgoing>>({});
  const [receiving, setReceiving] = useState<Receiving[]>([]);
  const [update, setUpdate] = useState<Update | null>(null);
  const timers = useRef(new Set<number>());
  /** Finished transfers (the Activity sheet); kept across restarts until cleared. */
  const [history, setHistory] = useState<ActivityEntry[]>(loadActivity);
  useEffect(() => saveActivity(history), [history]);
  const [activityOpen, setActivityOpen] = useState(false);
  const activityOpenRef = useRef(false);
  const [unseen, setUnseen] = useState(0);
  const log = useCallback((e: ActivityEntry) => {
    setHistory((l) => addEntry(l, e));
    if (!activityOpenRef.current) setUnseen((n) => n + 1);
  }, []);
  /** Who a transfer is with, for the log: sends by id once `api.send`
   *  returns, receives from the request. */
  const sendInfo = useRef(new Map<number, { who: string; files: number }>());
  const peerNames = useRef(new Map<number, string>());
  const logSend = useCallback(
    (id: number, result: SendOutcome) => {
      const info = sendInfo.current.get(id);
      if (!info) return; // result came early; sendTo logs it
      sendInfo.current.delete(id);
      const ok = result.outcome === "completed";
      const neutral = result.outcome === "declined" || result.outcome === "cancelled";
      log({
        id,
        dir: "out",
        who: info.who,
        text: ok ? `Sent ${plural(info.files, "file")}` : sendOutcomeText(result),
        tone: ok ? "ok" : neutral ? undefined : "bad",
        at: Date.now(),
      });
    },
    [log],
  );
  const later = useCallback((ms: number, f: () => void) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      f();
    }, ms);
    timers.current.add(t);
  }, []);
  // WHY: a send that fails fast (device gone, connection refused) can emit
  // its status and result before `api.send` has returned its id; keep them
  // here until `sendTo` adds the entry, or the row sticks on "Connecting…".
  const early = useRef(new Map<number, { status?: SendStatus; result?: SendOutcome }>());
  const fadeLater = useCallback((id: number, result: SendOutcome) => {
    // Good news fades; problems stay until the next try.
    if (!["completed", "declined", "cancelled"].includes(result.outcome)) return;
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setOutgoing((m) => {
        const { [id]: _, ...rest } = m;
        return rest;
      });
    }, NOTE_MS);
    timers.current.add(t);
  }, []);

  useEffect(() => {
    api.getState().then(setState, (e) => setFatal(errorText(e)));
    // Files from Send to / Open With may have arrived before we loaded.
    const takeShared = () =>
      api.takeShared().then((sel) => {
        if (sel) setShared(sel);
      });
    takeShared();
    /** The device drawn at (x, y) in CSS px, if any. */
    const deviceAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-device-id]");
      return devicesRef.current.find((d) => d.id === el?.dataset.deviceId) ?? null;
    };
    const subs = [
      // WHY: "Over" fires for every pointer move; keep the same object while
      // the device under the pointer is unchanged so React skips the render.
      on("drop-hover", (at) =>
        setDragging((prev) => {
          if (!at) return null;
          const over = deviceAt(at.x, at.y)?.id ?? null;
          const files = at.files ?? prev?.files ?? 0;
          const folders = at.folders ?? prev?.folders ?? 0;
          return prev && prev.over === over && prev.files === files && prev.folders === folders
            ? prev
            : { over, files, folders };
        }),
      ),
      // WHY: a drop is a deliberate gesture, but the send still goes through
      // the confirm sheet (or the picker when it missed a device).
      on("dropped", ({ selection, x, y }) => {
        setDragging(null);
        const device = deviceAt(x, y);
        if (device?.compatible) setConfirm({ device, selection });
        else setShared(selection);
      }),
      on("selection-error", (message) => {
        setDragging(null);
        setError(message);
      }),
      on("devices", (devices) => setState((s) => (s ? { ...s, devices } : s))),
      on("phones-online", (online_phones) => setState((s) => (s ? { ...s, online_phones } : s))),
      on("incoming", (req) => {
        peerNames.current.set(req.id, req.sender_name);
        setIncoming(req);
      }),
      on("shared", () => takeShared()),
      on("update-available", (u) => setUpdate(u)),
      on("settings-changed", (settings) => setState((s) => (s ? { ...s, settings } : s))),
      on("remote-status", (remote_status) =>
        setState((s) => (s ? { ...s, settings: { ...s.settings, remote_status } } : s)),
      ),
      on("recv-started", (r) => {
        peerNames.current.set(r.id, r.sender_name);
        setReceiving((list) => [...list, { id: r.id, from: r.sender_name, done: 0, total: r.total }]);
      }),
      on("recv-progress", (p) =>
        setReceiving((list) =>
          list.map((r) => (r.id === p.id ? { ...r, done: p.done, total: p.total } : r)),
        ),
      ),
      on("recv-finished", (f) => {
        setIncoming((cur) => (cur?.id === f.id ? null : cur));
        setReceiving((list) => list.map((r) => (r.id === f.id ? { ...r, finished: f } : r)));
        const ok = f.outcome === "completed";
        log({
          id: f.id,
          dir: "in",
          who: peerNames.current.get(f.id) ?? "Unknown device",
          text: recvOutcomeText(f),
          tone: ok ? "ok" : f.outcome === "failed" ? "bad" : undefined,
          at: Date.now(),
          canReveal: f.saved.length > 0,
        });
        peerNames.current.delete(f.id);
        // WHY: the toast fades on its own; Activity keeps the record.
        later(ok ? TOAST_MS : TOAST_PROBLEM_MS, () =>
          setReceiving((list) => list.filter((r) => r.id !== f.id)),
        );
      }),
      on("send-status", ({ id, status }) =>
        setOutgoing((m) => {
          if (m[id]) return { ...m, [id]: { ...m[id], status } };
          early.current.set(id, { ...early.current.get(id), status });
          return m;
        }),
      ),
      on("send-finished", ({ id, result }) => {
        setOutgoing((m) => {
          if (m[id]) return { ...m, [id]: { ...m[id], result } };
          early.current.set(id, { ...early.current.get(id), result });
          return m;
        });
        fadeLater(id, result);
        logSend(id, result);
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, []);

  const pickFor = useCallback(async (device: Device, folders = false) => {
    setError(null);
    try {
      const selection = await (folders ? api.pickFolders() : api.pickFiles());
      if (selection) setConfirm({ device, selection });
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const closeConfirm = useCallback(() => {
    if (confirm) api.clearSelection(confirm.selection.id);
    setConfirm(null);
  }, [confirm]);

  const sendTo = useCallback(async (device: Device, selection: Selection) => {
    try {
      const id = await api.send(selection.id, device.id);
      setRecent((r) => ({ ...r, [device.id]: Date.now() }));
      sendInfo.current.set(id, { who: device.name, files: selection.files.length });
      const seen = early.current.get(id);
      early.current.delete(id);
      if (seen?.result) logSend(id, seen.result);
      setOutgoing((m) => {
        // One note per device: drop the previous one for this device.
        const rest = Object.fromEntries(
          Object.entries(m).filter(([, o]) => o.deviceId !== device.id),
        );
        return {
          ...rest,
          [id]: {
            deviceId: device.id,
            status: seen?.status ?? { state: "connecting" },
            result: seen?.result,
          },
        };
      });
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const send = useCallback(() => {
    if (!confirm) return;
    setConfirm(null);
    sendTo(confirm.device, confirm.selection);
  }, [confirm, sendTo]);

  const answer = useCallback(
    (accept: boolean, trust: boolean) => {
      if (!incoming) return;
      api.respond(incoming.id, accept, trust).catch((e) => setError(errorText(e)));
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

  // A send that ends while "Stop sending?" is open clears the question, so it
  // can't pop up again on the next send to that device.
  const stoppingBusy =
    stopping !== null &&
    Object.values(outgoing).some((o) => o.deviceId === stopping.id && !o.result);
  useEffect(() => {
    if (stopping && !stoppingBusy) setStopping(null);
  }, [stopping, stoppingBusy]);

  if (fatal) return <main className="app"><p className="hint bad">{fatal}</p></main>;
  if (!state) return <main className="app" />;

  const devices = allDevices(state);
  devicesRef.current = devices;
  const activity: Record<string, DeviceActivity> = {};
  for (const o of Object.values(outgoing)) {
    activity[o.deviceId] = toActivity(o);
  }
  const trusted = new Set(state.settings.trusted.map((t) => t.id));
  /** What the "⋯" menu offers: only actions that exist for that device. */
  const menuFor = (d: Device): MenuItem[] => {
    const folder: MenuItem[] = d.compatible
      ? [{ label: "Send a folder…", onSelect: () => void pickFor(d, true) }]
      : [];
    if (d.os === "phone") {
      return [...folder, { label: "Remove phone…", danger: true, onSelect: () => setRemoving(d) }];
    }
    if (trusted.has(d.id)) {
      return [
        ...folder,
        {
          label: "Stop accepting automatically",
          onSelect: () =>
            api
              .untrust(d.id)
              .then((settings) => setState((s) => (s ? { ...s, settings } : s)))
              .catch((e) => setError(errorText(e))),
        },
      ];
    }
    return folder;
  };
  const cancelFor = (d: Device) => {
    const entry = Object.entries(outgoing).find(([, o]) => o.deviceId === d.id && !o.result);
    if (entry) api.cancelSend(Number(entry[0])).catch((e) => setError(errorText(e)));
  };

  return (
    <main className="app">
      <header className={scrolled ? "scrolled" : undefined}>
        <span className="wordmark">
          <svg className="logo" viewBox="195 30 130 130" aria-hidden>
            <LogoShapes />
          </svg>
          Yon
        </span>
        <button
          type="button"
          className="icon activity-button"
          aria-label={unseen ? `Activity, ${unseen} new` : "Activity"}
          title="Activity"
          onClick={() => {
            activityOpenRef.current = true;
            setActivityOpen(true);
            setUnseen(0);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 21a9 9 0 1 0-9-9" />
            <path d="M3 12h.01M12 7v5l3 2" />
          </svg>
          {unseen > 0 && <span className="badge" aria-hidden />}
        </button>
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
        <h1>
          {devices.length ? "Choose a device, or drop files on it" : "Looking for devices nearby"}
        </h1>
        <DropZone
          dragging={dragging}
          target={
            dragging?.over ? labels(devices)[dragging.over] ?? null : null
          }
        >
          <DeviceOrbit
            devices={devices}
            activity={activity}
            recent={recent}
            dragging={dragging !== null}
            dropTarget={dragging?.over ?? null}
            onPick={pickFor}
            onCancel={setStopping}
            menuFor={menuFor}
            error={state.discovery_error}
          />
        </DropZone>
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
                  className="icon small"
                  aria-label={`Show in ${fileManagerName}`}
                  title={`Show in ${fileManagerName}`}
                  onClick={() => api.reveal(r.id).catch((e) => setError(errorText(e)))}
                >
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  </svg>
                </button>
              )}
              {r.finished && (
                <button
                  type="button"
                  className="icon small"
                  aria-label="Dismiss"
                  // Only the toast goes; Activity can still show the files.
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

      {/* Always in reach, however long the device list gets. */}
      <button
        type="button"
        onClick={() => setPairing(true)}
        className="fixed right-6 bottom-6 z-10 flex min-h-12 items-center gap-2 rounded-full border border-white/40 bg-accent/85 py-3 pr-5 pl-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.55),0_12px_32px_-10px_var(--accent)] backdrop-blur-xl backdrop-saturate-150 transition-[transform,filter] duration-150 ease-snappy hover:brightness-105 motion-safe:active:scale-[0.97]"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="size-5 fill-none stroke-accent-ink stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"
        >
          <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
          <path d="M11 18.5h2" />
          <path d="M19.5 8v4M17.5 10h4" />
        </svg>
        <span className="font-semibold text-accent-ink">Pair a phone</span>
      </button>
      {update && <UpdateBar update={update} onLater={() => setUpdate(null)} />}
      <footer>
        You appear as <strong>{state.me.name}</strong>
      </footer>

      {shared && (
        <SharePicker
          selection={shared}
          devices={devices}
          recent={recent}
          onPick={(device) => {
            setShared(null);
            sendTo(device, shared);
          }}
          onClose={() => {
            api.clearSelection(shared.id);
            setShared(null);
          }}
        />
      )}
      {activityOpen && (
        <ActivitySheet
          entries={history}
          onReveal={(id) => api.reveal(id).catch((e) => setError(errorText(e)))}
          onClear={() => {
            // Rust forgets the paths too; nothing of these transfers is kept.
            for (const e of history) if (e.canReveal) api.forgetReceived(e.id);
            setHistory([]);
          }}
          onClose={() => {
            activityOpenRef.current = false;
            setActivityOpen(false);
          }}
        />
      )}
      {confirm && (
        <ConfirmSheet
          device={confirm.device}
          selection={confirm.selection}
          onSend={send}
          onAdd={(folders) =>
            api
              .addToSelection(confirm.selection.id, folders)
              .then((selection) => {
                if (selection) setConfirm((c) => (c ? { ...c, selection } : c));
              })
              .catch((e) => setError(errorText(e)))
          }
          onClose={closeConfirm}
        />
      )}
      {stopping && stoppingBusy && (
        <AskSheet
          title={`Stop sending to ${stopping.name}?`}
          body={`The file being sent is removed from ${stopping.name}. Files that already arrived stay there.`}
          keep="Keep sending"
          confirm="Stop sending"
          onConfirm={() => {
            cancelFor(stopping);
            setStopping(null);
          }}
          onClose={() => setStopping(null)}
        />
      )}
      {removing && (
        <AskSheet
          title={`Remove ${removing.name}?`}
          body="Its Yon icon stops working right away. To use it again, pair it again."
          keep="Cancel"
          confirm="Remove"
          onConfirm={() => {
            const id = removing.id.replace(/^phone:/, "");
            setRemoving(null);
            api
              .unpairPhone(id)
              .then((settings) => setState((s) => (s ? { ...s, settings } : s)))
              .catch((e) => setError(errorText(e)));
          }}
          onClose={() => setRemoving(null)}
        />
      )}
      {pairing && (
        <PairPhoneSheet
          online={state.online_phones}
          phones={state.settings.phones}
          onPaired={(settings) => setState((s) => (s ? { ...s, settings } : s))}
          onClose={() => setPairing(false)}
        />
      )}
      {settingsOpen && (
        <SettingsSheet
          state={state}
          onChange={setState}
          onUpdate={setUpdate}
          onClose={() => setSettingsOpen(false)}
        />
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
