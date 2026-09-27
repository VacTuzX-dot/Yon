#!/usr/bin/env bash
# Build the "Share → Yon" extension (YonShare.appex) without an Xcode project.
# Run by Tauri before bundling on macOS (tauri.macos.conf.json).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/YonShare"
tauri_dir="$(dirname "$here")"
out="$tauri_dir/target/yonshare/YonShare.appex"

# Use full Xcode if it's installed but not selected (no sudo needed).
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

version="$(plutil -extract version raw -o - "$tauri_dir/tauri.conf.json")"

rm -rf "$out"
mkdir -p "$out/Contents/MacOS"
cp "$src/Info.plist" "$out/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version" "$out/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version" "$out/Contents/Info.plist"

xcrun swiftc \
  -target arm64-apple-macos11 \
  -module-name YonShare \
  -parse-as-library \
  -application-extension \
  -O \
  -framework Cocoa \
  -Xlinker -e -Xlinker _NSExtensionMain \
  "$src/ShareViewController.swift" \
  -o "$out/Contents/MacOS/YonShare"

# Ad-hoc signature with the sandbox entitlement. A Developer ID identity can
# replace "-" once the project has one.
codesign --force --sign "${YON_SIGN_IDENTITY:--}" \
  --entitlements "$src/YonShare.entitlements" \
  --options runtime \
  "$out"

echo "built $out"
