<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="Yon icon">
</p>

<h1 align="center">Yon</h1>

<p align="center">Toss files to nearby devices.</p>

<p align="center">
  <a href="https://yon.meo.in.th/">Website</a> ·
  <a href="https://yon.meo.in.th/film/">Film</a> ·
  <a href="https://github.com/VacTuzX-dot/Yon/releases">Releases</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  English | <a href="README.th.md">ไทย</a>
</p>

Yon (โยน, Thai for "to toss") sends files and folders between your Macs, Windows PCs and phones. No account, no cloud. Files go straight from one device to the other, encrypted. Free and open source (MIT).

[![Yon in 72 seconds: click to watch the film](docs/yon-film.jpg)](https://yon.meo.in.th/film/)

<p align="center"><a href="https://yon.meo.in.th/film/"><b>▶ Watch "Yon in 72 seconds"</b></a><br>A WebGL film with an algorithmic soundtrack, made from code in this repo.</p>

## Updates

- **2026-09-29:** Yon 0.2.3. Send folders, Intel Macs, Windows on ARM, an Activity list, smaller notifications and security fixes. [Changelog](CHANGELOG.md)
- **2026-09-29:** [yon.meo.in.th](https://yon.meo.in.th/) is live, with a download button and the film.

## Features

- **Finds devices by itself.** Other Yon devices on your Wi-Fi show up automatically.
- **Files and folders.** Pick a device, pick files, send. To send a folder, drop it on a device or choose **Send a folder…** in the device's ⋯ menu. It arrives as a new folder with everything inside.
- **You decide what arrives.** The other side sees who is sending, the file list and the total size, then chooses **Accept** or **Decline**. Both sides see progress and can cancel.
- **Big files are fine.** Files are streamed, so 1 GB uses a few MB of memory. Every file is checked with SHA-256 when it arrives.
- **Nothing gets overwritten.** Files go to `Downloads/Yon` (you can change this). A name that already exists becomes `photo (1).jpg`.
- **Send from your file manager.** Windows: right-click → **Send to → Yon**. macOS: **Share → Yon**, **Open With → Yon**, or drop files on Yon's Dock icon.
- **Phones, no app.** Send between phones and computers with [Yon Link](docs/yon-link.md).
- **Stays in the background.** macOS: closing the window (⌘W) keeps Yon in the menu bar, and you can hide the Dock icon in Settings. Windows: closing sends it to the tray (turn this off in Settings). Quit from the menu bar or tray icon, or ⌘Q on macOS.

## Install

Download from [yon.meo.in.th](https://yon.meo.in.th/): pick Mac or Windows and the file downloads straight away. Or take a build from [Releases](https://github.com/VacTuzX-dot/Yon/releases), where each release starts with a table of direct links.

| Your computer | File |
|---|---|
| Mac, Apple Silicon (M1 and newer) | `Yon_x.y.z_aarch64.dmg` |
| Mac, Intel (0.2.3 and newer) | `Yon_x.y.z_x64.dmg` |
| Windows, x64 (Intel or AMD) | `Yon_x.y.z_x64-setup.exe` |
| Windows on ARM, Snapdragon (0.2.3 and newer) | `Yon_x.y.z_arm64-setup.exe` |

32-bit Windows isn't supported. The builds aren't notarized by Apple or signed for Windows yet, so your OS warns you the first time you open Yon. What changed in each version, and known problems with their fixes: [CHANGELOG](CHANGELOG.md).

### macOS

**From Terminal (skips the first-open warning):**

```bash
curl -fsSL https://yon.meo.in.th/mac | bash
```

The [script](install.sh) downloads the latest release, checks it against the release's `SHA256SUMS.txt` and the app's code signature, and puts Yon in `/Applications`, without `sudo`. Files fetched this way aren't marked as downloaded, so macOS opens Yon straight away. It trusts GitHub as much as the DMG does; read it first if you like. Run it again any time to reinstall. The website serves the same file at `/mac`, and it also runs from `https://raw.githubusercontent.com/VacTuzX-dot/Yon/main/install.sh`.

**From the DMG:**

1. Open the `.dmg` and drag Yon to Applications.
2. Open Yon. If macOS says it "could not verify" Yon, open System Settings → Privacy & Security and click **Open Anyway**. You only need to do this once.
3. When asked, allow Yon to find devices on your local network.
4. Optional, for **Share → Yon**: turn Yon on in System Settings → General → Login Items & Extensions → Sharing. macOS keeps new share extensions off until you do. Unsigned builds may not offer the Share extension at all; Open With always works.

### Windows

1. Run the installer.
2. If SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**.
3. When Windows Firewall asks, allow Yon on **Private networks**.

<details>
<summary>Install from PowerShell (advanced)</summary>

The installer above is the main way. If you'd rather use a script, download it, read it, then run it. The website doesn't offer this as a one-line command: pasting a remote script straight into PowerShell is how scams work, and ad blockers such as uBlock Origin warn about it.

```powershell
Invoke-WebRequest https://yon.meo.in.th/pwsh -OutFile "$env:TEMP\yon-install.ps1"
notepad "$env:TEMP\yon-install.ps1"
```

The [script](install.ps1) downloads the installer for your PC (x64 or ARM64) from this repository's GitHub release, checks its SHA-256 against the release's `SHA256SUMS.txt`, and runs it, per user, no admin. The check catches a broken or swapped download, not a compromised release. The installer itself isn't code-signed yet, and the script doesn't check a signature.

Windows PCs block script files by default, and you decide how to run this one. For a single run that changes nothing else:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\yon-install.ps1"
```

Set `$env:YON_VERSION = "0.2.3"` first for a specific version, or `$env:YON_SILENT = "1"` to skip the installer's window. The website serves the same file at `/pwsh`.

</details>

### Update Yon

Yon checks GitHub Releases for a new version shortly after it starts and every few hours. When one is out, a bar at the bottom of the window says so. Click **Update** and Yon downloads it, installs it over the old version and reopens.

You can turn automatic checks off, or check by hand, in **Settings → Updates**. Updating from 0.2.0 (any OS), or from 0.2.1 on macOS, needs one extra step: see the [CHANGELOG](CHANGELOG.md).

### Verify the download

Each release has a `SHA256SUMS.txt`. Put it next to the file you downloaded and run:

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS.txt
```

On Windows (PowerShell), compare the output of `Get-FileHash .\Yon_x.y.z_x64-setup.exe` with the matching line in `SHA256SUMS.txt`.

## Send from your phone

**Yon Link** lets an iPhone or Android phone send photos and files to your computer, and receive files from it, through a small web page that Yon serves on your Wi-Fi. There is nothing to install from an app store.

1. On the computer: **Settings → Phones → Pair a phone**. A QR code appears.
2. On the phone: scan the code with the Camera and tap the link.
3. Tap Share → **Add to Home Screen**.

From then on, tap the Yon icon on the phone. Sending from the computer to a phone, phone to phone, using it away from home and running your own relay are in [Yon Link](docs/yon-link.md).

## Security

- Every install has its own Ed25519 key. Computers talk over mutual TLS 1.3, and the sender checks it is talking to the exact device it discovered.
- The receiver sees the sender's **device code**, not just a name that could be faked.
- Nothing is written until you accept (unless you chose "Always accept" for that device). File and folder names are cleaned so they can't escape the save folder or overwrite anything.
- Yon only accepts connections from private network addresses. While it runs, it listens on your local network: quit it when you don't want to receive anything.
- Updates are signed and checked against a key built into the app. The update check is the only request Yon makes outside your local network.
- **Yon Link is less protected than the app.** The phone page is plain `http` on your LAN. Requests after it loads are encrypted with the phone's pairing key, but someone who can tamper with your Wi-Fi traffic could change the page and steal that key. Treat the QR code like a password, and remove a phone in Settings to cut it off.

Known limits: IPv4 only, the key is a file rather than in the system keychain, and builds aren't signed yet. Everything in detail: [Security](docs/security.md).

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

| Check | Command |
|---|---|
| Types and lint | `bun run typecheck && bun run lint` |
| Rust | `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` |
| JavaScript tests | `bun run test` |

`bun run test` checks that the phone page's encryption matches the Rust side byte for byte (shared vectors in `web/crypto-vectors.json`). CI also runs `cargo audit` and `bun audit` (known vulnerabilities in dependencies) and checks that Yon compiles for Intel Macs and Windows on ARM.

Two opt-in tests:

```bash
# The phone page in a desktop browser, against a real Link server (auto-accepts, prints a pairing URL)
bun run build:link && cd src-tauri && cargo test --test link -- --ignored serve_page_for_browser --nocapture
```

```bash
# A 1 GB end-to-end transfer
cd src-tauri && cargo test --release --test transfer -- --ignored one_gigabyte --nocapture
```

Building releases, update signing and code signing: [Releasing](docs/releasing.md).

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

- **Next:** send text and the clipboard, transfer history.
- **Later:** transfers across networks (via [iroh](https://iroh.computer)), optional LocalSend compatibility, native mobile apps.

## License

[MIT](LICENSE)
