// In-page QR scanner for the phone page (ADR-004, spec "Camera and decoder").
// Full-screen overlay, rear camera, one frame in flight. Every exit path goes
// through finish(), which stops the camera.
// WHY: the page CSP is style-src 'self', so styles are set through CSSOM only.

/** Minimal BarcodeDetector typing; the TS DOM lib doesn't ship it. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = (new (o: { formats: string[] }) => BarcodeDetectorLike) & {
  getSupportedFormats(): Promise<string[]>;
};

const INTERVAL_MS = 150;
const MAX_SIDE = 640;
const MAX_DETECT_FAILURES = 10;

/** Camera + secure context available (getUserMedia exists and isSecureContext). */
export function canScan(): boolean {
  return isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function";
}

function abortError(): DOMException {
  return new DOMException("Scan cancelled", "AbortError");
}

/** Native QR detector when the browser has one; null means "use the worker". */
async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  if (!("BarcodeDetector" in window)) return null;
  const BD = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  try {
    const formats = await BD.getSupportedFormats();
    return formats.includes("qr_code") ? new BD({ formats: ["qr_code"] }) : null;
  } catch {
    // WHY: some engines expose the constructor but reject the format probe; the worker path still works.
    return null;
  }
}

/** Opens a full-screen overlay with the rear camera and a Cancel button; resolves with the first QR text found.
 * Rejects with DOMException "AbortError" on Cancel / signal abort / pagehide, or with the getUserMedia error (e.g. NotAllowedError, NotFoundError). */
export function scanQr(signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let finished = false;
    let stream: MediaStream | null = null;
    let worker: Worker | null = null;
    let detector: BarcodeDetectorLike | null = null;
    let canvasCtx: CanvasRenderingContext2D | null = null;
    let timer: number | undefined;
    let busy = false;
    let detectFailures = 0;
    // WHY: restore focus to whatever had it before the overlay opened (keyboard and screen-reader users).
    const previousFocus = document.activeElement;

    const overlay = document.createElement("div");
    const video = document.createElement("video");
    const hint = document.createElement("p");
    const cancel = document.createElement("button");
    const canvas = document.createElement("canvas"); // offscreen; never attached to the DOM

    // Runs exactly once, whichever exit path gets there first.
    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      worker?.terminate();
      video.srcObject = null;
      signal?.removeEventListener("abort", onAbort);
      window.removeEventListener("pagehide", onAbort);
      cancel.removeEventListener("click", onAbort);
      overlay.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      settle();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    const onDecoded = (e: MessageEvent<unknown>): void => {
      busy = false;
      const text = e.data;
      if (typeof text === "string" && text.length > 0) finish(() => resolve(text));
    };
    const getWorker = (): Worker => {
      if (!worker) {
        // WHY: created lazily, only on browsers without BarcodeDetector.
        worker = new Worker("qr-worker.js");
        worker.onmessage = onDecoded;
        worker.onerror = () => finish(() => reject(new Error("QR decoder failed to load")));
      }
      return worker;
    };

    const tick = (): void => {
      if (busy || finished || video.readyState < 2 || video.videoWidth === 0) return;
      busy = true;
      if (detector) {
        detector.detect(video).then(
          (codes) => {
            busy = false;
            detectFailures = 0;
            const text = codes[0]?.rawValue;
            if (text) finish(() => resolve(text));
          },
          (err: unknown) => {
            busy = false;
            // WHY: a single failed frame is transient; only a run of failures means the detector is broken.
            detectFailures += 1;
            if (detectFailures >= MAX_DETECT_FAILURES) finish(() => reject(err));
          },
        );
        return;
      }
      // WHY: downscale before decoding; a 640 px side is plenty for a pairing QR and keeps each frame cheap.
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      canvas.width = width;
      canvas.height = height;
      canvasCtx ??= canvas.getContext("2d", { willReadFrequently: true });
      if (!canvasCtx) {
        finish(() => reject(new Error("Canvas is not available for scanning")));
        return;
      }
      canvasCtx.drawImage(video, 0, 0, width, height);
      const { data } = canvasCtx.getImageData(0, 0, width, height);
      // WHY: transfer the pixel buffer instead of copying it; the page doesn't read it again.
      getWorker().postMessage({ data, width, height }, [data.buffer as ArrayBuffer]);
    };

    // Overlay: built with createElement only (never innerHTML), text via textContent.
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      zIndex: "1000",
      background: "#000",
    });
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Scan QR code");

    Object.assign(video.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
    });
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;

    Object.assign(hint.style, {
      position: "absolute",
      top: "calc(env(safe-area-inset-top) + 16px)",
      left: "16px",
      right: "16px",
      margin: "0",
      color: "#fff",
      textAlign: "center",
      font: "16px/1.4 system-ui, sans-serif",
      textShadow: "0 1px 3px #000",
    });
    hint.textContent = "Point at the QR code in Yon on your computer";

    cancel.type = "button";
    cancel.textContent = "Cancel";
    Object.assign(cancel.style, {
      position: "absolute",
      bottom: "calc(env(safe-area-inset-bottom) + 24px)",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "12px 28px",
      border: "0",
      borderRadius: "999px",
      background: "rgba(255,255,255,0.9)",
      color: "#000",
      font: "17px system-ui, sans-serif",
      cursor: "pointer",
    });

    overlay.append(video, hint, cancel);
    document.body.append(overlay);
    cancel.focus();

    signal?.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("pagehide", onAbort);
    cancel.addEventListener("click", onAbort);

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        // WHY: Cancel can land while the permission prompt is open; the camera must not start after that.
        if (finished) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = s;
        // WHY: iOS sometimes ignores the autoplay attribute on a fresh srcObject; play() starts it explicitly. A failure only means no frames yet, and the decode loop waits on readyState.
        void video.play().catch(() => {});
        return nativeDetector().then((d) => {
          if (finished) return;
          detector = d;
          timer = window.setInterval(tick, INTERVAL_MS);
        });
      })
      .catch((err: unknown) => finish(() => reject(err)));
  });
}
