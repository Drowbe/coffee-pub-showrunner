#!/usr/bin/env bash
# For builds made without an Apple certificate: signs the whole app "ad hoc" (no certificate needed), then rebuilds the zip and dmg from it.
# Without this the app has no valid signature as a whole, so macOS cannot tell it is one app and never remembers a camera, microphone or
# Screen Recording answer: it asks again every time. Usage: scripts/adhoc-sign-mac.sh dist
set -euo pipefail
DIST="${1:-dist}"
APP="$(ls -d "$DIST"/mac-universal/*.app | head -1)"
NAME="$(basename "$APP" .app)"
VERSION="$(node -p "require('./package.json').version")"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1 | grep -E "Identifier|Signature|Sealed"

rm -f "$DIST"/*.zip "$DIST"/*.dmg
ditto -c -k --keepParent "$APP" "$DIST/$NAME-$VERSION-universal-mac.zip"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DIST/$NAME-$VERSION-universal.dmg"
rm -rf "$STAGE"
ls -l "$DIST"/*.zip "$DIST"/*.dmg
