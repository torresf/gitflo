#!/bin/sh
# Build gitflo and replace the copy in /Applications with it.
#
# The running app is quit first and relaunched after: copying over a live
# bundle works, but the old binary would keep running until the next launch.
set -eu

APP=/Applications/gitflo.app
BUILT=src-tauri/target/release/bundle/macos/gitflo.app

cd "$(dirname "$0")/.."

# The .app only: the .dmg is for sharing, and takes longer to build.
npm run tauri build -- --bundles app

if pgrep -f "$APP/Contents/MacOS/gitflo" >/dev/null; then
  osascript -e "tell application \"$APP\" to quit"
  # Give it a moment to flush its settings before the bundle goes away.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP/Contents/MacOS/gitflo" >/dev/null || break
    sleep 0.5
  done
fi

rm -rf "$APP"
ditto "$BUILT" "$APP"
open "$APP"

echo "gitflo $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString) installé dans $APP"
