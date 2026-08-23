#!/usr/bin/env bash
# Build the native macOS screen recorder helper (ScreenCaptureKit).
#
# Produces a universal (arm64 + x86_64) binary at src/bin/orange-fuji-recorder,
# which media-binaries.js resolves in development and electron-builder ships
# via extraResources (src/bin -> resources/bin).
#
# Requirements: Xcode command line tools (swiftc).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_SRC="$SRC_DIR/src/bin/orange-fuji-recorder.swift"
OUT="$SRC_DIR/src/bin/orange-fuji-recorder"
BUILD_DIR="$(mktemp -d)"

trap 'rm -rf "$BUILD_DIR"' EXIT

echo "Building orange-fuji-recorder (arm64)..."
swiftc -O -target arm64-apple-macos12.3 -o "$BUILD_DIR/ofr-arm64" "$SWIFT_SRC"

echo "Building orange-fuji-recorder (x86_64)..."
swiftc -O -target x86_64-apple-macos12.3 -o "$BUILD_DIR/ofr-x64" "$SWIFT_SRC"

lipo -create "$BUILD_DIR/ofr-arm64" "$BUILD_DIR/ofr-x64" -output "$OUT"
chmod +x "$OUT"
lipo -info "$OUT"
