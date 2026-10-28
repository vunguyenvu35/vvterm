#!/bin/sh
# Adds the Settings helper to a built macOS app: a second, tiny app bundle inside it with LSUIElement=1,
# so macOS never gives the Settings process a Dock icon. Its executable is a hard link to the main binary
# (no extra disk space), which makes the helper's own Info.plist the one that applies.
#   scripts/macos-settings-helper.sh build/bin/vvterm.app
set -eu
APP="${1:?usage: $0 path/to/vvterm.app}"
EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
HELPER="$APP/Contents/Helpers/VVTerm Settings.app"
rm -rf "$HELPER"
mkdir -p "$HELPER/Contents/MacOS"
ln "$APP/Contents/MacOS/$EXE" "$HELPER/Contents/MacOS/vvterm-settings" 2>/dev/null \
  || cp "$APP/Contents/MacOS/$EXE" "$HELPER/Contents/MacOS/vvterm-settings"
cat > "$HELPER/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>VVTerm Settings</string>
  <key>CFBundleExecutable</key><string>vvterm-settings</string>
  <key>CFBundleIdentifier</key><string>com.wails.vvterm.settings</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
echo "settings helper: $HELPER"
