import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText, type Qr, type Settings } from "../api";
import { LogoShapes } from "./Logo";

interface Props {
  /** Phones whose Yon page is open (ids); tells us the scan worked. */
  online: string[];
  onPaired: (s: Settings) => void;
  onClose: () => void;
}

/** How long "Paired" stays up before the sheet closes itself. */
const CONNECTED_MS = 2500;

/** Pair a phone for Yon Link: name it, then scan the QR once. */
export default function PairPhoneSheet({ online, onPaired, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("My phone");
  const [qr, setQr] = useState<{ id: string; main: Qr; fallback: Qr | null; anywhere: boolean } | null>(
    null,
  );
  const [useIp, setUseIp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => ref.current?.showModal(), []);
  // The phone opened its Yon page: pairing worked, so the code can go.
  const connected = qr !== null && online.includes(qr.id);
  useEffect(() => {
    if (!connected) return;
    const t = window.setTimeout(onClose, CONNECTED_MS);
    return () => window.clearTimeout(t);
  }, [connected, onClose]);

  async function pair(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const p = await api.pairPhone(name);
      setQr({ id: p.phone_id, main: p.qr, fallback: p.fallback, anywhere: p.anywhere });
      onPaired(p.settings);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const shown = qr && (useIp && qr.fallback ? qr.fallback : qr.main);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="pair-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {connected ? (
        <div className="pair paired" role="status">
          <span className="paired-check" aria-hidden>
            ✓
          </span>
          <h2 id="pair-title">{name} is paired</h2>
          <p className="hint">
            Send from the phone with the Yon icon, or pick it in Yon to send files to it.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : !shown ? (
        <form onSubmit={pair}>
          <h2 id="pair-title">Pair a phone</h2>
          <p className="hint">
            Send photos and files from an iPhone or Android phone to this computer. No app to
            install: you scan a code once and keep a Yon icon on your Home Screen.
          </p>
          <label className="field">
            <span>Phone name</span>
            <input
              value={name}
              maxLength={63}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          {error && <p className="hint bad">{error}</p>}
          <div className="actions">
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              Show code
            </button>
          </div>
        </form>
      ) : (
        <div className="pair">
          <h2 id="pair-title">Scan with {name}</h2>
          <QrCode qr={shown} />
          <ol className="steps">
            <li>Open the Camera on your phone and point it at the code.</li>
            <li>Tap the link. The phone must be on the same Wi-Fi as this computer.</li>
            <li>
              Tap Share, then <b>Add to Home Screen</b> (Android: menu ⋮, then Add to Home screen).
              Next time, just tap the Yon icon.
            </li>
          </ol>
          {qr.fallback && (
            <button type="button" className="link" onClick={() => setUseIp(!useIp)}>
              {useIp
                ? "Use the normal code"
                : qr.anywhere
                  ? "Only use it at home? Faster Wi-Fi-only code"
                  : "Link doesn't open? Try this code instead"}
            </button>
          )}
          <p className="hint">
            {useIp
              ? qr.anywhere
                ? "This code works only on this Wi-Fi, without the relay."
                : "This code uses the computer's current IP address, so it may stop working when your Wi-Fi changes it."
              : qr.anywhere
                ? "Works on any network through the relay. Anyone who scans it can ask to send you files; remove the phone in Settings to stop it."
                : "Anyone who scans this code can ask to send you files. Remove the phone in Settings to stop it."}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Dark-on-white regardless of theme (scanners need it), logo in the centre. */
function QrCode({ qr }: { qr: Qr }) {
  const quiet = 4;
  const logo = Math.floor(qr.size * 0.2); // ≤ 20% of the width; EC level H covers it
  const pad = 1;
  const at = (qr.size - logo) / 2;
  return (
    <svg
      className="qr"
      viewBox={`${-quiet} ${-quiet} ${qr.size + quiet * 2} ${qr.size + quiet * 2}`}
      role="img"
      aria-label="QR code to pair your phone"
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={qr.size + quiet * 2} height={qr.size + quiet * 2} fill="#fff" />
      <path d={qr.path} fill="#000" />
      <rect x={at - pad} y={at - pad} width={logo + pad * 2} height={logo + pad * 2} fill="#fff" />
      <svg x={at} y={at} width={logo} height={logo} viewBox="195 30 130 130" shapeRendering="auto">
        <LogoShapes />
      </svg>
    </svg>
  );
}
