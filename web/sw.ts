// Service worker for the phone page, built to sw.js next to link.js (scripts/build-link.ts).
// Only install, activate, push and notificationclick. There is NO fetch listener and no
// cache: this worker can never intercept a request, and page-code updates reach the
// phone unchanged (threat model: docs/threat-model-phone-push.md).

// WHY: the DOM lib has no service-worker types; declare only what this file uses.
type Client = { visibilityState: string; url: string; focus(): Promise<Client> };
type ExtendableEvent = { waitUntil(p: Promise<unknown>): void };
type PushEvent = ExtendableEvent & { data?: { json(): unknown } | null };
type NotificationClickEvent = ExtendableEvent & { notification: { close(): void } };

const sw = self as unknown as {
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "push", fn: (e: PushEvent) => void): void;
  addEventListener(type: "notificationclick", fn: (e: NotificationClickEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<Client[]>;
    openWindow(url: string): Promise<unknown>;
  };
  registration: {
    scope: string;
    showNotification(title: string, options: NotificationOptions): Promise<void>;
  };
};

// WHY: a waiting worker would keep the old code on iOS Home Screen apps; take over at once.
sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

const FALLBACK = { title: "Yon", body: "Files are waiting" };

/** The offer's sender and count, or null for anything else. Never trusts the shape. */
function offerOf(e: PushEvent): { from: string; n: number } | null {
  let v: unknown;
  try {
    v = e.data?.json(); // WHY: a payload that is not JSON falls back below, it must not throw
  } catch {
    return null;
  }
  const o = v as { t?: unknown; from?: unknown; n?: unknown } | null;
  if (o?.t !== "offer" || typeof o.from !== "string" || typeof o.n !== "number") return null;
  if (!Number.isSafeInteger(o.n) || o.n < 1) return null;
  // WHY: the name comes from a computer; cap it so a long one can't fill the banner.
  return { from: o.from.slice(0, 64), n: o.n };
}

async function notify(e: PushEvent): Promise<void> {
  // WHY: with userVisibleOnly every push must show a notification. Chrome otherwise shows its own generic one, and Safari revokes the subscription after a few silent pushes.
  const open = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = open.some((c) => c.visibilityState === "visible");
  const offer = offerOf(e);
  // WHY: the notification names no files (the offer lives behind the sealed session), only the sender and count.
  const title = offer?.from ?? FALLBACK.title;
  const body = !offer ? FALLBACK.body : offer.n === 1 ? "wants to send you a file" : `wants to send you ${offer.n} files`;
  // WHY: a visible page already shows the offer, so this one is silent: no sound or vibration, the banner only.
  await sw.registration.showNotification(title, { body, tag: "yon-offer", icon: "icon.png", data: { url: "./" }, silent: visible });
}

sw.addEventListener("push", (e) => e.waitUntil(notify(e)));

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      // WHY: scope check, so a window of another app on this origin is never focused.
      const open = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const own = open.find((c) => c.url.startsWith(sw.registration.scope));
      if (own) await own.focus();
      else await sw.clients.openWindow("./");
    })(),
  );
});
