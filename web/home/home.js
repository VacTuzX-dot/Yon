// Phones paired before the page moved here open https://yon.meo.in.th/#<pairing>
// (GitHub Pages sends the old URL to this origin's root). Send them on to the
// phone page with the pairing intact. The fragment never leaves this browser.
if (/^#[0-9a-f]{32}\.[0-9a-f]{64}/i.test(location.hash)) {
  location.replace("/phonelink/" + location.hash);
}

// Download dialog. Without JS the buttons still go to the releases page.
document.addEventListener("click", (e) => {
  const dialog = document.getElementById("download");
  if (!dialog || !dialog.showModal) return;
  const t = e.target instanceof Element ? e.target : null;
  const link = t && t.closest("a[data-download]");
  if (link && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button)) {
    e.preventDefault();
    dialog.showModal();
  } else if (t === dialog || (t && t.closest(".dl-close"))) {
    dialog.close(); // t === dialog: a click on the backdrop
  } else if (t && t.closest("[data-os]")) {
    const os = t.closest("[data-os]").dataset.os;
    for (const b of dialog.querySelectorAll("[data-os]")) b.setAttribute("aria-pressed", String(b.dataset.os === os));
    for (const l of dialog.querySelectorAll("[data-list]")) l.hidden = l.dataset.list !== os;
  }
});
