#!/usr/bin/env bash
# Regenerates the PWA icons from the brand mark.
#
# assets/mark.png is the Sirony Connect symbol, already cropped square out of
# the full lockup (the wordmark is dropped — it is unreadable at 48px).
#
# Uses `sips`, so this is macOS-only. The generated PNGs are committed, so a
# Linux checkout never needs to run this.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="assets/mark.png"
OUT="public/icons"

command -v sips >/dev/null || { echo "sips not found (macOS only)" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# gen <canvas> <artwork> <outfile> — insets the mark on a black canvas so it
# has breathing room and never touches the edge.
gen() {
  sips -z "$2" "$2" "$SRC" --out "$tmp/a.png" >/dev/null
  sips -p "$1" "$1" --padColor 000000 "$tmp/a.png" --out "$3" >/dev/null
}

gen 512 440 "$OUT/icon-512.png"
gen 192 166 "$OUT/icon-192.png"
gen 180 156 "$OUT/apple-touch-icon.png"
# 76% of the canvas keeps the mark inside Android's circular safe zone.
gen 512 390 "$OUT/maskable-512.png"

echo "icons regenerated in $OUT"
