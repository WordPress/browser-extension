#!/usr/bin/env bash
#
# Builds a clean, installable Chrome extension zip from the runtime files.
# Output: release/wordpress-browser-extension-<version>-chrome.zip
#
# To install: unzip → chrome://extensions → Developer mode →
# Load unpacked → select the unzipped folder.
#
# Mirrors the file list from scripts/sync-safari.sh (which is the
# canonical "shipping" set), minus the host-app wrapper.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/release"
mkdir -p "$DIST"
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
STAGE="$DIST/.stage-chrome"
ZIP="$DIST/wordpress-browser-extension-$VERSION-chrome.zip"

# Always rebuild so the zip reflects current source.
echo "Building popup bundle..."
npm run build > /dev/null

rm -rf "$STAGE"
mkdir -p "$STAGE/lib" "$STAGE/popup" "$STAGE/options" "$STAGE/dist" "$STAGE/icons"

cp manifest.json    "$STAGE/"
cp background.js    "$STAGE/"
cp content.js       "$STAGE/"

# i18n catalogs — the manifest's __MSG_*__ fields (default_locale) and every
# chrome.i18n.getMessage() call resolve against these.
cp -R _locales "$STAGE/_locales"

cp lib/early.js            "$STAGE/lib/"
cp lib/detect.js           "$STAGE/lib/"
cp lib/rest.js             "$STAGE/lib/"
cp lib/host.js             "$STAGE/lib/"
cp lib/block-inspector.js  "$STAGE/lib/"
cp lib/editor-preferences.js "$STAGE/lib/"
cp lib/my-sites.js         "$STAGE/lib/"

cp popup/popup.html "$STAGE/popup/"

cp options/options.html "$STAGE/options/"
cp options/options.css  "$STAGE/options/"
cp options/options.js   "$STAGE/options/"

cp dist/popup.css "$STAGE/dist/"
cp dist/popup.js  "$STAGE/dist/"

cp icons/*.png "$STAGE/icons/"

# Integrity gate: every file the manifest / popup / background references must
# be present in the stage, or the zip would install or run broken. Fails the
# build (set -e) if anything is missing.
node "$ROOT/scripts/verify-package.js" "$STAGE"

rm -f "$ZIP"
( cd "$STAGE" && zip -rq "$ZIP" . )
rm -rf "$STAGE"

echo "Built: $ZIP ($(du -h "$ZIP" | cut -f1))"
