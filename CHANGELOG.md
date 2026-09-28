# Changelog

Known problems are in red boxes, with the version that fixes them and what to do if you're affected.

## 0.2.3 — unreleased

### New

- **Send folders.** Drop a folder on a device, choose **Send a folder…** from a device's ⋯ menu, or use **Add a folder** before sending. The folder arrives as a new folder next to your other received files (`Photos`, or `Photos (1)` if one is already there) with everything inside in place. Links inside folders are skipped, not followed. Computers on 0.2.2 or older still receive the files, without the folders. Phones get the files without folders.
- **Intel Macs** and **Windows on ARM** (Snapdragon PCs) get their own downloads. The Mac install script picks the right one.
- Every CI run checks Rust and JavaScript dependencies for known vulnerabilities (`cargo audit`, `bun audit`) and that Yon still builds for Intel Macs and Windows on ARM.

## 0.2.2 — 2026-09-28

### New

- **Reach from anywhere in one click.** Phones on cellular or another Wi-Fi can send to this computer through the built-in relay (off by default; Settings → Phones). You can use your own relay under Settings → Advanced.
- **Pair again.** Phones paired before show "Home Wi-Fi only · Pair again". The old link keeps working until the phone opens the new one.
- **Drop files on a device** to send them, with a drop zone while you drag.
- **Many devices:** from five on, devices show as a searchable list, ready ones first, most recently used on top.
- **Pair a phone** is always one tap away at the bottom right.
- Settings save as you go, with one Done button. Stopping a send asks first.
- New look: translucent glass surfaces, lighter on the GPU while scrolling.

### Fixed

- **macOS: updates no longer open as "damaged".** Yon now lifts the downloaded-file mark from its own app after a verified update. This works for updates *made by* 0.2.2 or later, so the next update after 0.2.2 is the first one without the warning.
- The macOS app is now signed as a whole (ad-hoc), so macOS says "could not verify" instead of "damaged" on first open.
- Sends that can't connect fail after 15 seconds instead of spinning forever.
- Relay addresses with a path are rejected; a planted `.yonpart` file is never followed.

> [!CAUTION]
> **Updating from 0.2.0 in the app fails.** Updates are signed with a new key from 0.2.2 on, and 0.2.0 only knows the old one.
> **Fix:** download 0.2.2 from [Releases](https://github.com/VacTuzX-dot/Yon/releases/tag/v0.2.2) and install it over the old one, or on a Mac run the [install script](README.md#install).

> [!CAUTION]
> **macOS, updating from 0.2.1:** after clicking Update, macOS says Yon can't be opened ("damaged" or "could not verify"). The update is fine; 0.2.1 marked it as downloaded.
> **Fix (once):** System Settings → Privacy & Security → **Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Yon.app` in Terminal, or reinstall with the [install script](README.md#install). Later updates don't need this.

## 0.2.1 — 2026-09-28

- Bridge release for a new update signing key: 0.2.1 itself is signed with the old key (so 0.2.0 can update to it) and trusts only the new one.

> [!CAUTION]
> **macOS: updates installed from inside the app open as "damaged".** Yon marks every file it writes as downloaded, and that included its own update. Affects updating 0.2.0 → 0.2.1 and 0.2.1 → 0.2.2. Windows is not affected.
> **Fixed in 0.2.2.** If you're affected, see the 0.2.2 note above.

## 0.2.0 — 2026-09-27

### New

- **Yon Link:** send photos and files between phones and computers through a web page on your Wi-Fi, no app to install. Pair with a QR code; phones can also send to each other through the computer.
- **In-app updates**, checked shortly after start and every few hours, signed and verified before install.
- **Reach from anywhere** (early version): phones reach the computer through a relay you run yourself.
- macOS: option to hide the Dock icon.

### Fixed

- Windows: "Show in folder" uses the Shell API.
- Hex device codes containing `+` are rejected.

> [!CAUTION]
> **macOS: in-app updates open as "damaged"** (same problem as 0.2.1). **Fixed in 0.2.2.**

> [!CAUTION]
> **Can't update in the app past 0.2.1** because of the new update key. Install 0.2.2 by hand once (see the 0.2.2 note).

## 0.1.1 — 2026-09-27

### New

- Menu bar / tray icon; closing the window keeps Yon running.
- Always accept files from devices you trust.
- Send from Windows Explorer (Send to → Yon), Finder (Open With → Yon) and macOS Share → Yon.
- Releases include `SHA256SUMS.txt`.

### Fixed

- Device names with bidi or invisible characters are cleaned, so they can't pretend to be another device.
- Discovery tries every address a device announces, best first.
- Changing the port no longer stops receiving.

> [!WARNING]
> No in-app updates yet: install newer versions by hand.

## 0.1.0 — 2026-09-27

First release: find devices on your Wi-Fi, send files over mutual TLS 1.3, accept or decline, progress and cancel on both sides, SHA-256 check on arrival.

> [!WARNING]
> No in-app updates: install newer versions by hand.

---

All versions: the apps aren't notarized by Apple or signed for Windows, so the first open shows a warning (macOS: Privacy & Security → **Open Anyway**; Windows: **More info → Run anyway**). The Mac [install script](README.md#install) skips the macOS warning.
