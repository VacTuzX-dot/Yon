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

## Install

Download the latest build from [Releases](https://github.com/VacTuzX-dot/Yon/releases).

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Yon_x.y.z_aarch64.dmg` |
| Windows (x64) | `Yon_x.y.z_x64-setup.exe` |

The builds are not code-signed yet, so your OS will warn you the first time.

**macOS:** open the `.dmg`, drag Yon to Applications, then right-click Yon → **Open** → **Open**. You only need to do this once. When asked, allow Yon to find devices on your local network.

**Windows:** run the installer. If SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**. When Windows Firewall asks, allow Yon on **Private networks**.

## Security

- Every install has its own Ed25519 key. Connections use mutual TLS 1.3, and the sender checks it is talking to the exact device it discovered.
- The receiver sees the sender's **device code** (for example `A1B2-C3D4-E5F6-0718`). Device names can be faked; if you're unsure, ask the sender to open Settings in Yon and compare codes.
- Nothing is written until you accept. File names are cleaned so they can't escape the save folder or collide with system names.
- Received files are marked as downloaded (macOS quarantine / Windows Mark-of-the-Web), so the OS still checks them when opened.
- Yon only accepts connections from private network addresses.

Known limits of this version: IPv4 only, the key is stored as a file in the app's data folder (not in the system keychain), and there is no "trusted devices only" mode yet.

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
bun run lint
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
src-tauri/tests/     end-to-end transfer tests over TLS
```

## Roadmap

- **Next:** drag and drop, send folders, send text / clipboard, transfer history, tray icon, trusted devices.
- **Later:** transfers across networks (via [iroh](https://iroh.computer)), optional LocalSend compatibility, mobile apps.

## License

[MIT](LICENSE)
