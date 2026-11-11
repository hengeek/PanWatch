#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PROJECT_ROOT="$(cd .. && pwd)"
FRONTEND="$PROJECT_ROOT/frontend"
(cd "$FRONTEND" && pnpm run build:desktop)
APP="$PWD/build/PanWatch.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Desktop"
cp -R "$FRONTEND/dist-desktop/." "$APP/Contents/Resources/Desktop/"
swiftc PanWatch/main.swift PanWatch/APIResponse.swift -o "$APP/Contents/MacOS/PanWatch" -framework AppKit -framework WebKit -O
cp PanWatch/Resources/* "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PanWatch</string>
<key>CFBundleIdentifier</key><string>app.panwatch.desktop</string>
<key>CFBundleName</key><string>PanWatch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
printf '已构建：%s\n' "$APP"
