#!/usr/bin/env bash
#
# Mirrors the shipping extension files into the Safari Xcode project's
# Resources directory. The Xcode project references files from there via
# relative paths, so this has to run whenever a runtime file changes
# (manifest, background, content scripts, popup build output, icons).
#
# Usage: scripts/sync-safari.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/safari/WordPress Browser Extension/WordPress Browser Extension Extension/Resources"

if [ ! -d "$DEST" ]; then
  echo "Safari Xcode project not found at: $DEST" >&2
  echo "Re-generate it with: xcrun safari-web-extension-converter (see SAFARI.md)" >&2
  exit 1
fi

# Wipe sub-folders so deletes in source propagate; top-level files are
# overwritten below so the DEST listing matches source exactly.
rm -rf "$DEST/lib" "$DEST/popup" "$DEST/options" "$DEST/dist" "$DEST/icons" "$DEST/_locales"
mkdir -p "$DEST/lib" "$DEST/popup" "$DEST/options" "$DEST/dist" "$DEST/icons"

cp "$ROOT/manifest.json" "$DEST/"
cp "$ROOT/background.js" "$DEST/"
cp "$ROOT/content.js"    "$DEST/"

# i18n message catalogs — the manifest's __MSG_*__ name/description and every
# chrome.i18n.getMessage() call resolve against these, so Safari needs them too.
cp -R "$ROOT/_locales" "$DEST/_locales"

cp "$ROOT/lib/early.js"            "$DEST/lib/"
cp "$ROOT/lib/detect.js"           "$DEST/lib/"
cp "$ROOT/lib/rest.js"             "$DEST/lib/"
cp "$ROOT/lib/host.js"             "$DEST/lib/"
cp "$ROOT/lib/block-inspector.js"  "$DEST/lib/"
cp "$ROOT/lib/editor-preferences.js" "$DEST/lib/"
cp "$ROOT/lib/my-sites.js"         "$DEST/lib/"

cp "$ROOT/popup/popup.html" "$DEST/popup/"

cp "$ROOT/options/options.html" "$DEST/options/"
cp "$ROOT/options/options.css"  "$DEST/options/"
cp "$ROOT/options/options.js"   "$DEST/options/"

cp "$ROOT/dist/popup.css" "$DEST/dist/"
cp "$ROOT/dist/popup.js"  "$DEST/dist/"

# One full-color icon set ships to both browsers. Safari only template-tints
# an icon it reads as monochrome; a genuinely-colored icon renders as-is (the
# opt-out — see #15/#26), so the same icons/*.png that Chrome uses keep all
# three states distinct in Safari too. (Do NOT reintroduce a monochrome/
# silhouette set for Safari — it collapses logged-in and logged-out to one
# tinted W.)
cp "$ROOT/icons"/*.png "$DEST/icons/"

echo "Synced runtime files → $DEST"
