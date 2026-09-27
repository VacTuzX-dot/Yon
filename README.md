<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="Yon icon">
</p>

# Yon

Toss files to nearby devices. The name comes from the Thai word "โยน" (to toss).

Yon is a small, open-source desktop app for sending files between computers on the same network: macOS and Windows today. No account, no cloud. Files go straight from one device to the other, encrypted.

> Screenshots coming soon.

## What it does

- Finds other Yon devices on your Wi-Fi automatically.
- Tap a device, pick files, send. The other side sees who is sending, the file list and total size, and chooses Accept or Decline.
- Progress on both sides, with Cancel on both sides.
- Large files are streamed, so a 1 GB file uses a few MB of memory, and every file is checked with SHA-256 when it arrives.
- Received files go to `Downloads/Yon` (you can change this). Existing files are never overwritten: you get `photo (1).jpg` instead.
- Send from your file manager: on Windows, right-click → **Send to → Yon**; on macOS, use **Share → Yon** (from Finder or any app), **Open With → Yon**, or drop files on Yon's Dock icon. Yon asks which device to send to.
- Stays ready in the background: on macOS, closing the window (⌘W) keeps Yon in the menu bar; on Windows, closing sends it to the tray (turn this off in Settings). On macOS you can also hide the Dock icon in Settings to keep Yon in the menu bar only. Quit from the menu bar / tray icon, or ⌘Q on macOS.

## Install

Download the latest build from [Releases](https://github.com/VacTuzX-dot/Yon/releases).

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Yon_x.y.z_aarch64.dmg` |
| Windows (x64) | `Yon_x.y.z_x64-setup.exe` |

The builds are not code-signed yet, so your OS will warn you the first time.

**macOS:** open the `.dmg`, drag Yon to Applications, then right-click Yon → **Open** → **Open**. You only need to do this once. When asked, allow Yon to find devices on your local network. To get **Share → Yon**, turn Yon on in System Settings → General → Login Items & Extensions → Sharing (macOS keeps new share extensions off until you do). Unsigned builds may not offer the Share extension at all; Open With always works.

**Windows:** run the installer. If SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**. When Windows Firewall asks, allow Yon on **Private networks**.

### Verify the download

Each release has a `SHA256SUMS.txt`. Put it next to the file you downloaded and run:

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS.txt
```

On Windows (PowerShell), compare the output of `Get-FileHash .\Yon_x.y.z_x64-setup.exe` with the matching line in `SHA256SUMS.txt`.

## Security

- Every install has its own Ed25519 key. Connections use mutual TLS 1.3, and the sender checks it is talking to the exact device it discovered.
- The receiver sees the sender's **device code** (for example `A1B2-C3D4-E5F6-0718`). Device names can be faked; if you're unsure, ask the sender to open Settings in Yon and compare codes.
- Nothing is written until you accept — unless you ticked "Always accept from this device" for that sender. That list is matched by device code (the key proven in the connection), not by name, and you can remove devices in Settings. File names are cleaned so they can't escape the save folder or collide with system names.
- Received files are marked as downloaded (macOS quarantine / Windows Mark-of-the-Web), so the OS still checks them when opened.
- Yon only accepts connections from private network addresses.
- While Yon is running (including in the menu bar / tray) it listens on your local network for requests. Quit it when you don't want to receive anything.

Known limits of this version: IPv4 only, the key is stored as a file in the app's data folder (not in the system keychain), and there is no mode that ignores unknown devices entirely yet.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.3, [Rust](https://rustup.rs) (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun tauri dev
```

Run two instances on one machine (each needs its own identity and data folder):

```bash
YON_DATA_DIR=/tmp/yon-a bun tauri dev
```

```bash
YON_DATA_DIR=/tmp/yon-b ./src-tauri/target/debug/yon
```

The second instance shares the first one's dev server and picks a free port automatically.

### Checks

```bash
bun run typecheck && bun run lint
```

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

The 1 GB end-to-end transfer test is opt-in:

```bash
cd src-tauri && cargo test --release --test transfer -- --ignored one_gigabyte --nocapture
```

### Build

```bash
bun tauri build
```

Installers end up in `src-tauri/target/release/bundle/`. Releases are built by GitHub Actions when a `v*` tag is pushed; the tag must match the version in `tauri.conf.json`, `package.json` and `Cargo.toml`.

### Signing (not set up yet)

Builds are unsigned. Signing needs credentials that belong to the maintainer:

- **macOS:** an Apple Developer ID Application certificate and notarization credentials, stored as GitHub Actions secrets for `tauri-action` (see Tauri's [macOS signing guide](https://v2.tauri.app/distribute/sign/macos/)).
- **Windows:** an Authenticode code-signing certificate (see Tauri's [Windows signing guide](https://v2.tauri.app/distribute/sign/windows/)).

## Project layout

```
src/                 React UI (TypeScript, plain CSS)
src-tauri/src/
  app.rs             Tauri commands and events (the UI never handles file paths)
  discovery.rs       mDNS advertise/browse (_yon._tcp)
  identity.rs        device key, certificate, mutual-TLS verifiers
  protocol.rs        wire format (length-prefixed JSON frames)
  server.rs          receiving side
  client.rs          sending side
  transfer.rs        streaming, hashing, safe file creation
  sanitize.rs        file name cleaning
  settings.rs        settings file
  platform.rs        OS-specific helpers
src-tauri/macos/     "Share → Yon" extension (Swift, built by build-share.sh)
src-tauri/windows/   installer hooks (Send To shortcut)
src-tauri/tests/     end-to-end transfer tests over TLS
```

## Roadmap

- **Next:** drag and drop, send folders, send text / clipboard, transfer history, tray icon, trusted devices.
- **Later:** transfers across networks (via [iroh](https://iroh.computer)), optional LocalSend compatibility, mobile apps.

## License

[MIT](LICENSE)
