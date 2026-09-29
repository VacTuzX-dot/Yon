// Phones paired before the page moved here open https://yon.meo.in.th/#<pairing>
// (GitHub Pages sends the old URL to this origin's root). Send them on to the
// phone page with the pairing intact. The fragment never leaves this browser.
if (/^#[0-9a-f]{32}\.[0-9a-f]{64}/i.test(location.hash)) {
  location.replace("/phonelink/" + location.hash);
}

// Everything below is polish on top of plain links: without JS the download
// buttons go to the releases page and the code can still be selected.
const dialog = document.getElementById("download");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const PRESSABLE = ".button, .dl-os button, .dl-list a, .dl-close, .copy";

// Ink that spreads from where you pressed.
function ink(el, e) {
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const dot = document.createElement("span");
  dot.className = "ink";
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  el.append(dot);
  dot.addEventListener("animationend", () => dot.remove());
}

// A few marigold and vermilion petals, thrown outwards from the press.
function petals(x, y, n) {
  if (still) return;
  const host = dialog && dialog.open ? dialog : document.body;
  const box = host === dialog ? dialog.getBoundingClientRect() : { left: 0, top: 0 };
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (i % 2) * 0.4;
    const d = 46 + ((i * 37) % 5) * 12;
    const p = document.createElement("span");
    p.className = "petal";
    p.style.cssText = `left:${x - box.left}px;top:${y - box.top}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 14}px;--r:${(i * 97) % 360}deg;--c:${i % 4 === 3 ? "var(--shu)" : "var(--accent)"}`;
    host.append(p);
    p.addEventListener("animationend", () => p.remove());
  }
}

function openDialog(from) {
  const r = from.getBoundingClientRect();
  dialog.classList.remove("closing");
  dialog.showModal();
  // The dialog grows out of the button that opened it.
  const d = dialog.getBoundingClientRect();
  dialog.style.setProperty("--ox", `${r.left + r.width / 2 - d.left}px`);
  dialog.style.setProperty("--oy", `${r.top + r.height / 2 - d.top}px`);
}

function closeDialog() {
  if (still || !dialog.open) return dialog.close();
  dialog.classList.add("closing");
  const finish = () => {
    clearTimeout(fallback);
    dialog.removeEventListener("animationend", onEnd);
    dialog.classList.remove("closing");
    if (dialog.open) dialog.close();
  };
  const onEnd = (e) => e.target === dialog && finish(); // the petals and rows animate inside it too
  // A hidden tab doesn't run animations; never leave the dialog stuck open.
  const fallback = setTimeout(finish, 400);
  dialog.addEventListener("animationend", onEnd);
}

function pick(os) {
  const box = dialog.querySelector(".dl-os");
  box.dataset.picked = os;
  for (const b of box.querySelectorAll("[data-os]")) b.setAttribute("aria-pressed", String(b.dataset.os === os));
  for (const l of dialog.querySelectorAll("[data-list]")) l.hidden = l.dataset.list !== os;
  dialog.querySelector("#dl-status").textContent = "";
  for (const a of dialog.querySelectorAll("a.started")) a.classList.remove("started");
}

// The field lives inside the box that asked, so it also works in the open
// dialog (everything behind a modal dialog is inert).
function legacyCopy(text, host) {
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.className = "clip";
  host.append(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // fall through: the tip tells the visitor to copy by hand
  }
  field.remove();
  return ok;
}

async function copy(button) {
  const box = button.closest(".code");
  const code = box.querySelector("code");
  const tip = box.querySelector(".copy-tip");
  const text = code.textContent.trim();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text, box);
  }
  if (!ok) {
    // Leave the command selected, ready for Ctrl/⌘ C.
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  tip.textContent = ok ? "Copied" : "Couldn't copy. Select the command and press Ctrl/⌘ C.";
  tip.classList.add("show");
  button.classList.toggle("copied", ok);
  clearTimeout(button.timer);
  button.timer = setTimeout(() => {
    tip.classList.remove("show");
    button.classList.remove("copied");
  }, ok ? 2000 : 5000);
}

if (dialog && dialog.showModal) {
  // Suggest the visitor's own system; they still choose.
  const mine = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "mac" : /Win/.test(navigator.userAgent) ? "win" : "";
  if (mine) dialog.querySelector(`[data-os="${mine}"]`).dataset.suggest = "";

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault(); // Esc: close with the exit animation
    closeDialog();
  });
}

document.addEventListener("pointerdown", (e) => {
  const el = e.target instanceof Element ? e.target.closest(PRESSABLE) : null;
  if (el && !still && e.button === 0) ink(el, e);
});

document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const at = { x: e.clientX || innerWidth / 2, y: e.clientY || innerHeight / 2 };

  const copyButton = t.closest(".copy");
  if (copyButton) return void copy(copyButton);

  if (!dialog || !dialog.showModal) return;
  const link = t.closest("a[data-download]");
  if (link && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button)) {
    e.preventDefault();
    openDialog(link);
  } else if (t === dialog || t.closest(".dl-close")) {
    closeDialog(); // t === dialog: a click on the backdrop
  } else if (t.closest("[data-os]")) {
    pick(t.closest("[data-os]").dataset.os);
    petals(at.x, at.y, 6);
  } else if (t.closest(".dl-list a[href]")) {
    // Let the download start; say what to do next.
    const a = t.closest(".dl-list a");
    for (const other of dialog.querySelectorAll("a.started")) other.classList.remove("started");
    a.classList.add("started");
    dialog.querySelector("#dl-status").textContent = a.dataset.hint || "Downloading…";
    petals(at.x, at.y, 12);
  }
});
