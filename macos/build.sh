#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$PROJECT_ROOT/frontend"
APP="$SCRIPT_DIR/build/PanWatch.app"
ARCH="$(uname -m)"
VERSION="${PANWATCH_VERSION:-0.2.0}"

case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "不支持的 Mac 架构：$ARCH" >&2; exit 2 ;;
esac

(cd "$FRONTEND" && pnpm run build:desktop)
python3 - "$APP" <<'PY'
import shutil, sys
from pathlib import Path
path = Path(sys.argv[1])
if path.exists(): shutil.rmtree(path)
PY
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Desktop"
cp -R "$FRONTEND/dist-desktop/." "$APP/Contents/Resources/Desktop/"
ICONSET="$SCRIPT_DIR/build/PanWatch.iconset"
mkdir -p "$ICONSET"
for spec in "16 16" "16@2x 32" "32 32" "32@2x 64" "128 128" "128@2x 256" "256 256" "256@2x 512" "512 512"; do
  name="${spec%% *}"
  size="${spec##* }"
  suffix="${name%@*}"
  scale="${name#*@}"
  if [[ "$name" == *"@"* ]]; then
    output="icon_${suffix}x${suffix}@${scale}.png"
  else
    output="icon_${size}x${size}.png"
  fi
  sips -z "$size" "$size" "$FRONTEND/public/icon-512.png" --out "$ICONSET/$output" >/dev/null
done
iconutil -c icns -o "$APP/Contents/Resources/PanWatch.icns" "$ICONSET"
python3 - "$ICONSET" <<'PY'
import shutil, sys
from pathlib import Path
shutil.rmtree(Path(sys.argv[1]))
PY
swiftc \
  -O -swift-version 5 -target "$ARCH-apple-macosx12.0" \
  "$SCRIPT_DIR/PanWatch/main.swift" \
  "$SCRIPT_DIR/PanWatch/AppDelegate.swift" \
  "$SCRIPT_DIR/PanWatch/DesktopResourceSchemeHandler.swift" \
  "$SCRIPT_DIR/PanWatch/APIResponse.swift" \
  "$SCRIPT_DIR/PanWatch/DesktopRoutePolicy.swift" \
  "$SCRIPT_DIR/PanWatch/KeychainSessionStore.swift" \
  -o "$APP/Contents/MacOS/PanWatch" \
  -framework AppKit -framework WebKit -framework Security -framework Carbon -framework UserNotifications -framework ServiceManagement
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PanWatch</string>
<key>CFBundleIdentifier</key><string>app.panwatch.desktop</string>
<key>CFBundleName</key><string>PanWatch</string>
<key>CFBundleDisplayName</key><string>PanWatch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>PanWatch</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSApplicationCategoryType</key><string>public.app-category.finance</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSLocalNetworkUsageDescription</key><string>连接你配置的 PanWatch 服务以读取持仓、关注股票与行情。</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - --identifier app.panwatch.desktop "$APP"
codesign --verify --deep --strict "$APP"
file "$APP/Contents/MacOS/PanWatch"
printf '已构建并验证：%s（%s，macOS 12+）\n' "$APP" "$ARCH"
