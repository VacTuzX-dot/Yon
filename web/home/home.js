// Phones paired before the page moved here open https://yon.meo.in.th/#<pairing>
// (GitHub Pages sends the old URL to this origin's root). Send them on to the
// phone page with the pairing intact. The fragment never leaves this browser.
if (/^#[0-9a-f]{32}\.[0-9a-f]{64}/i.test(location.hash)) {
  location.replace("/phonelink/" + location.hash);
}
