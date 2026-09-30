# Security

How Yon protects your files, and where it doesn't. Threat models and decisions: [Yon Link](threat-model-yon-link.md), [relay](threat-model-link-relay.md), [ADR-001](adr/ADR-001-yon-link-web-mode.md).

## Between computers

- Every install has its own Ed25519 key. Connections use mutual TLS 1.3, and the sender checks it is talking to the exact device it discovered.
- The receiver sees the sender's **device code** (for example `A1B2-C3D4-E5F6-0718`). Device names can be faked; if you're unsure, ask the sender to open Settings in Yon and compare codes.
- Nothing is written until you accept, unless you ticked "Always accept from this device" for that sender. That list is matched by device code (the key proven in the connection), not by name, and you can remove devices in Settings.
- File and folder names are cleaned so they can't escape the save folder or collide with system names. A received folder is always created new, never merged into one that's already there.
- Received files are marked as downloaded (macOS quarantine, Windows Mark-of-the-Web), so the OS still checks them when opened.
- Yon only accepts connections from private network addresses.
- While Yon is running (including in the menu bar or tray) it listens on your local network for requests. Quit it when you don't want to receive anything.

## On your computer

- **Open Yon when I log in** is off until you turn it on in Settings. It adds one entry in your own profile (a LaunchAgent on macOS, a `Run` value on Windows), needs no admin rights, and starts Yon hidden. Turning the setting off removes the entry; uninstalling on Windows does too. On macOS, deleting the app leaves the small file `~/Library/LaunchAgents/io.github.vactuzx-dot.yon.login.plist`, which then does nothing.
- **Activity** keeps the last 50 transfers across restarts in the app's storage on this computer: which device, what happened (for example "Received 3 files") and when. File names and paths are never saved, and a failure's reason is dropped because an error can name a file. **Clear** removes it.

## Updates

Updates are signed. Yon installs an update only if its signature matches the public key built into the app, so a changed download is refused. The update check is the only request Yon makes outside your local network: it asks GitHub for the latest version and sends nothing about you or your files.

## Yon Link (phones)

**Yon Link is less protected than the app.**

- The phone page is plain `http` on your LAN, because browsers only allow secure pages to talk to local devices with a trusted certificate.
- Every request after the page loads is encrypted and authenticated with the phone's pairing key (ChaCha20-Poly1305), so other people on the Wi-Fi can't read or fake uploads.
- Someone able to tamper with your Wi-Fi traffic could change the page itself and steal the pairing key.
- Requests from phones are labelled "web link", and you still accept each one unless you chose "Always accept".
- The pairing key is in the QR code and the phone's saved link, so treat them like a password. Remove a phone in Settings to cut it off at once.
- Yon Link only listens (on port 53421) while at least one phone is paired.

## Known limits of this version

- IPv4 only.
- The key is stored as a file in the app's data folder, not in the system keychain.
- There is no mode that ignores unknown devices entirely yet.
- The builds aren't notarized by Apple or signed for Windows yet.
