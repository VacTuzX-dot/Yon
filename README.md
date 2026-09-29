<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="Yon icon">
</p>

# Yon

Toss files to nearby devices. The name comes from the Thai word "โยน" (to toss). Website and download: [yon.meo.in.th](https://yon.meo.in.th/).

Yon is a small, open-source desktop app for sending files between computers on the same network: macOS and Windows today. No account, no cloud. Files go straight from one device to the other, encrypted.

[![Yon in 72 seconds: click to watch the film](docs/yon-film.jpg)](https://yon.meo.in.th/film/)

<p align="center"><a href="https://yon.meo.in.th/film/"><b>▶ Watch "Yon in 72 seconds"</b></a> (a WebGL film with an algorithmic soundtrack, made from code in this repo)</p>

## What it does

- Finds other Yon devices on your Wi-Fi automatically.
- Tap a device, pick files, send. Folders too: drop one on a device or choose **Send a folder…** from the device's ⋯ menu; it arrives as a new folder with everything inside. The other side sees who is sending, the file list and total size, and chooses Accept or Decline.
- Progress on both sides, with Cancel on both sides.
- Large files are streamed, so a 1 GB file uses a few MB of memory, and every file is checked with SHA-256 when it arrives.
- Received files go to `Downloads/Yon` (you can change this). Existing files are never overwritten: you get `photo (1).jpg` instead.
- Send from your file manager: on Windows, right-click → **Send to → Yon**; on macOS, use **Share → Yon** (from Finder or any app), **Open With → Yon**, or drop files on Yon's Dock icon. Yon asks which device to send to.
- Send files between your phones and computers with **Yon Link**, no app to install on the phone (see below).
- Stays ready in the background: on macOS, closing the window (⌘W) keeps Yon in the menu bar; on Windows, closing sends it to the tray (turn this off in Settings). On macOS you can also hide the Dock icon in Settings to keep Yon in the menu bar only. Quit from the menu bar / tray icon, or ⌘Q on macOS.

## Install

Download from [yon.meo.in.th](https://yon.meo.in.th/) (pick Mac or Windows and the file downloads straight away), or take the latest build from [Releases](https://github.com/VacTuzX-dot/Yon/releases).

| Platform | File |
|---|---|
| macOS (Apple Silicon: M1 and newer) | `Yon_x.y.z_aarch64.dmg` |
| macOS (Intel) | `Yon_x.y.z_x64.dmg` (0.2.3 and newer) |
| Windows (x64: Intel or AMD) | `Yon_x.y.z_x64-setup.exe` |
| Windows on ARM (Snapdragon) | `Yon_x.y.z_arm64-setup.exe` (0.2.3 and newer) |

Each release page starts with a table of direct download links. 32-bit Windows isn't supported.

The builds aren't notarized by Apple or signed for Windows, so your OS warns you the first time. What changed in each version, and known problems with their fixes: [CHANGELOG](CHANGELOG.md).

**macOS, from Terminal (skips the warning):**

```bash
curl -fsSL https://raw.githubusercontent.com/VacTuzX-dot/Yon/main/install.sh | bash
```

The [script](install.sh) downloads the latest release, checks it against the release's `SHA256SUMS.txt` and the app's code signature, and puts Yon in `/Applications`, without `sudo`. Files fetched this way aren't marked as downloaded, so macOS opens Yon straight away. It trusts GitHub as much as the DMG does; read it first if you like. Run it again any time to reinstall.

**macOS, from the DMG:** open the `.dmg`, drag Yon to Applications and open it. macOS says it "could not verify" Yon: open System Settings → Privacy & Security and click **Open Anyway**. You only need to do this once. When asked, allow Yon to find devices on your local network. To get **Share → Yon**, turn Yon on in System Settings → General → Login Items & Extensions → Sharing (macOS keeps new share extensions off until you do). Unsigned builds may not offer the Share extension at all; Open With always works.

**Windows, from PowerShell:**

```powershell
irm https://raw.githubusercontent.com/VacTuzX-dot/Yon/main/install.ps1 | iex
```

The [script](install.ps1) downloads the installer for your PC (x64 or ARM64), checks it against the release's `SHA256SUMS.txt` and runs it (per user, no admin). Set `$env:YON_VERSION = "0.2.3"` first for a specific version, or `$env:YON_SILENT = "1"` to skip the installer's window. It trusts GitHub as much as the installer download does; read it first if you like.

**Windows, from the installer:** run the installer. If SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**. When Windows Firewall asks, allow Yon on **Private networks**.

### Updates

Yon checks GitHub Releases for a new version shortly after it starts and every few hours. When one is out, a bar at the bottom of the window says so: click **Update** and Yon downloads it, installs it over the old version and reopens. Files left behind by earlier updates are cleaned up on the next start. Updating from 0.2.0 (any OS), or from 0.2.1 on macOS, needs one extra step; see the [CHANGELOG](CHANGELOG.md). You can turn automatic checks off, or check by hand, in **Settings → Updates**.

### Phones (Yon Link)

iPhone and Android phones send photos and files to your computer through a small web page that Yon serves on your Wi-Fi. There's nothing to install from an app store.

1. On the computer: **Settings → Phones → Pair a phone**, give the phone a name, and a QR code appears.
2. On the phone: open the Camera, scan the code, and tap the link. The phone must be on the same Wi-Fi.
3. Tap Share → **Add to Home Screen** (Android: menu ⋮ → Add to Home screen).

From then on, tap the Yon icon on your phone:

- **Phone → computer:** choose photos or files, then accept on the computer.
- **Computer → phone:** your paired phones show up next to other computers in Yon. Pick one, choose files, and tap Receive on the phone (its Yon page has to be open, or opened within 10 minutes). In Safari the files go to Files → Downloads; from the Home Screen icon, tap Save on each file, then Share → Save to Files (or Save Image/Video for photos and videos). Up to 1 GB at a time.
- **Phone → phone:** when another paired phone has its Yon page open, it appears under "Send to". The computer passes the files along (Yon must be running there) and the other phone taps Receive.

You only scan once. If the link doesn't open (some Android phones can't use `.local` names), tap "Link doesn't open?" under the QR code for a code that uses the computer's IP address instead.

**From anywhere (optional).** Turn on **Settings → Phones → Reach from anywhere**. Release builds come with a relay run by the maintainer; to use your own, enter it under **Settings → Advanced → Relay address**. New pairings then open the phone page from https://yon.meo.in.th/phonelink/ and reach this computer through the relay, on any network. The relay only passes on encrypted data and stores nothing; it does see internet addresses, when devices connect and how much they send. Phones paired before show **Pair again**: scan the new code, and the old link keeps working until the phone connects with the new one. Run your own relay: `YON_RELAY_TAG=dev docker compose up -d --build` in `relay/` (it listens on 127.0.0.1 only; put Cloudflare Tunnel or another TLS proxy in front), then `bun relay/check.ts wss://<your host>` to check the WebSocket path end to end. `.github/workflows/relay.yml` + `relay/deploy.sh` deploy it with health checks and rollback; `.github/workflows/website.yml` + `website/deploy.sh` do the same for the website.

Keep the phone's screen on while a big file is sending or arriving. If the phone locks, the transfer continues from where it stopped when you come back, as long as it's within about 5 minutes.

### Verify the download

Each release has a `SHA256SUMS.txt`. Put it next to the file you downloaded and run:

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS.txt
```

On Windows (PowerShell), compare the output of `Get-FileHash .\Yon_x.y.z_x64-setup.exe` with the matching line in `SHA256SUMS.txt`.

## Security

- Every install has its own Ed25519 key. Connections use mutual TLS 1.3, and the sender checks it is talking to the exact device it discovered.
- The receiver sees the sender's **device code** (for example `A1B2-C3D4-E5F6-0718`). Device names can be faked; if you're unsure, ask the sender to open Settings in Yon and compare codes.
- Nothing is written until you accept — unless you ticked "Always accept from this device" for that sender. That list is matched by device code (the key proven in the connection), not by name, and you can remove devices in Settings. File and folder names are cleaned so they can't escape the save folder or collide with system names, and a received folder is always created new, never merged into one that's already there.
- Received files are marked as downloaded (macOS quarantine / Windows Mark-of-the-Web), so the OS still checks them when opened.
- Yon only accepts connections from private network addresses.
- While Yon is running (including in the menu bar / tray) it listens on your local network for requests. Quit it when you don't want to receive anything.
- Updates are signed. Yon installs an update only if its signature matches the public key built into the app, so a changed download is refused. The update check is the only request Yon makes outside your local network; it asks GitHub for the latest version and sends nothing about you or your files.
- **Yon Link (phones) is less protected than the app.** The phone page is plain `http` on your LAN, because browsers only allow secure pages to talk to local devices with a trusted certificate. Every request after the page loads is encrypted and authenticated with the phone's pairing key (ChaCha20-Poly1305), so other people on the Wi-Fi can't read or fake uploads. But someone able to tamper with your Wi-Fi traffic could change the page itself and steal the pairing key. Requests from phones are labelled "web link", and you still accept each one unless you chose "Always accept". The pairing key is in the QR code and the phone's saved link, so treat them like a password. Remove a phone in Settings to cut it off at once. Yon Link only listens (on port 53421) while at least one phone is paired. Details: [threat model](docs/threat-model-yon-link.md), [ADR-001](docs/adr/ADR-001-yon-link-web-mode.md).

Known limits of this version: IPv4 only, the key is stored as a file in the app's data folder (not in the system keychain), and there is no mode that ignores unknown devices entirely yet.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.3, [Rust](https://rustup.rs) (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun tauri dev
```

`bun run build` and `bun run dev` also build the phone page (`web/`) into `src-tauri/link-dist/`, which the Rust binary embeds. If you run `cargo` directly on a fresh checkout, run `bun run build:link` once first.

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

```bash
bun run test
```

CI also runs `cargo audit` and `bun audit` (known vulnerabilities in dependencies) and checks that Yon compiles for Intel Macs and Windows on ARM.

`bun run test` checks that the phone page's encryption matches the Rust side byte for byte (shared vectors in `web/crypto-vectors.json`).

To try the phone page in a desktop browser against a real Link server (it auto-accepts and prints a pairing URL):

```bash
bun run build:link && cd src-tauri && cargo test --test link -- --ignored serve_page_for_browser --nocapture
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

### Update signing

Releases need the updater key pair (separate from OS code signing):

```bash
bun tauri signer generate -w ~/.tauri/yon-updater.key
```

Put the public key (`~/.tauri/yon-updater.key.pub`) in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and the private key and its password in the GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup of the private key offline: if it's lost, installed copies can't be updated any more; if it leaks, someone else could sign updates. The release workflow stops if the public key is missing.

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
  link/              Yon Link: phone web page server, HTTP framing, session crypto, relay client
web/                 phone page (vanilla TS) and the project page (web/home/), built by scripts/build-link.ts
website/             static server for https://yon.meo.in.th (project page + /phonelink/), deployed by .github/workflows/website.yml
relay/               Yon Link relay for "Reach from anywhere" (Bun, no dependencies; Dockerfile, compose.yaml, deploy.sh, check.ts)
src-tauri/macos/     "Share → Yon" extension (Swift, built by build-share.sh)
src-tauri/windows/   installer hooks (Send To shortcut)
src-tauri/tests/     end-to-end tests: transfers over TLS, a fake phone over Yon Link
```

## Roadmap

- **Next:** send text / clipboard, transfer history.
- **Later:** transfers across networks (via [iroh](https://iroh.computer)), optional LocalSend compatibility, native mobile apps.

## License

[MIT](LICENSE)
