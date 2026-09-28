#!/bin/bash
# Install Yon on macOS (Apple Silicon) from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/VacTuzX-dot/Yon/main/install.sh | bash
#
# Options (environment variables):
#   YON_VERSION=0.2.2        install this version instead of the latest
#   YON_INSTALL_DIR=~/Applications   install somewhere other than /Applications
#   YON_NO_OPEN=1            don't open Yon afterwards
#
# What it does: downloads the app from the release, checks its SHA-256 against
# the release's SHA256SUMS.txt and its code signature, then puts Yon.app in
# /Applications. No sudo. Files fetched with curl aren't marked as downloaded,
# so macOS opens Yon without the "Open Anyway" step.
# WHY: this trusts GitHub (the repo and its releases) exactly as much as the
# DMG does; the checksum catches broken or swapped downloads, not a
# compromised repo. Updates later come from inside the app, which checks the
# update's signature against the key built into Yon.

# Everything runs inside main, so a download cut off halfway runs nothing.
main() {
  set -euo pipefail

  local repo="VacTuzX-dot/Yon"
  local dir="${YON_INSTALL_DIR:-/Applications}"
  local base
  if [[ -n "${YON_VERSION:-}" ]]; then
    [[ "$YON_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "YON_VERSION must look like 0.2.2"
    base="https://github.com/$repo/releases/download/v$YON_VERSION"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi

  [[ "$(uname -s)" == Darwin ]] || die "this script is for macOS. On Windows, download the installer from https://github.com/$repo/releases"
  [[ "$(uname -m)" == arm64 ]] || die "Yon is built for Apple Silicon Macs only."
  [[ -d "$dir" && -w "$dir" ]] || die "can't write to $dir. Try: YON_INSTALL_DIR=~/Applications (create it first)"
  if pgrep -f "$dir/Yon.app/Contents/MacOS/" >/dev/null; then
    die "Yon is running. Quit it (menu bar icon → Quit) and run this again."
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "Checking the release…"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt"
  local line name sum
  line="$(grep -E '^[0-9a-f]{64}  Yon_[0-9]+\.[0-9]+\.[0-9]+_aarch64\.app\.tar\.gz$' "$tmp/SHA256SUMS.txt")" \
    || die "the release has no macOS app."
  [[ "$(wc -l <<<"$line")" -eq 1 ]] || die "the release lists more than one macOS app."
  sum="${line%%  *}"
  name="${line#*  }"

  say "Downloading $name…"
  curl -fL --proto '=https' --tlsv1.2 --progress-bar -o "$tmp/$name" "$base/$name"
  [[ "$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)" == "$sum" ]] \
    || die "the download doesn't match SHA256SUMS.txt. Nothing was installed."

  # Only Yon.app/… inside the archive: no absolute paths, no '..'.
  if tar -tzf "$tmp/$name" | grep -qvE '^Yon\.app(/|$)' || tar -tzf "$tmp/$name" | grep -qE '(^|/)\.\.(/|$)'; then
    die "unexpected files in the archive. Nothing was installed."
  fi
  mkdir "$tmp/app"
  tar -xzf "$tmp/$name" -C "$tmp/app"
  codesign --verify --deep --strict "$tmp/app/Yon.app" 2>/dev/null \
    || die "the app's code signature doesn't check out. Nothing was installed."

  # Swap in place; put the old copy back if the move fails.
  if [[ -e "$dir/Yon.app" ]]; then
    mv "$dir/Yon.app" "$tmp/old.app"
  fi
  if ! mv "$tmp/app/Yon.app" "$dir/Yon.app"; then
    [[ -e "$tmp/old.app" ]] && mv "$tmp/old.app" "$dir/Yon.app"
    die "couldn't move Yon into $dir."
  fi

  say "Installed Yon $(defaults read "$dir/Yon.app/Contents/Info" CFBundleShortVersionString) in $dir."
  [[ -n "${YON_NO_OPEN:-}" ]] || open "$dir/Yon.app"
}

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mYon install: %s\033[0m\n' "$*" >&2; exit 1; }

main "$@"
