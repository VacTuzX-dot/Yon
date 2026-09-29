# Releasing

Releases are built by GitHub Actions when a `v*` tag is pushed. The tag must match the version in `tauri.conf.json`, `package.json` and `Cargo.toml`.

```bash
bun tauri build
```

Installers end up in `src-tauri/target/release/bundle/`.

## Update signing

Releases need the updater key pair (separate from OS code signing):

```bash
bun tauri signer generate -w ~/.tauri/yon-updater.key
```

Put the public key (`~/.tauri/yon-updater.key.pub`) in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and the private key and its password in the GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep a backup of the private key offline. If it's lost, installed copies can't be updated any more. If it leaks, someone else could sign updates. The release workflow stops if the public key is missing.

## Code signing (not set up yet)

Builds are unsigned. Signing needs credentials that belong to the maintainer:

- **macOS:** an Apple Developer ID Application certificate and notarization credentials, stored as GitHub Actions secrets for `tauri-action` (see Tauri's [macOS signing guide](https://v2.tauri.app/distribute/sign/macos/)).
- **Windows:** an Authenticode code-signing certificate (see Tauri's [Windows signing guide](https://v2.tauri.app/distribute/sign/windows/)).
