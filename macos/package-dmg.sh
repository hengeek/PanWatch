#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${PANWATCH_VERSION:-0.2.0}"
ARCH="$(uname -m)"
APP="$SCRIPT_DIR/build/PanWatch.app"
STAGING="$SCRIPT_DIR/build/dmg-root"
DMG="$SCRIPT_DIR/build/PanWatch-${VERSION}-${ARCH}.dmg"
IDENTITY="${PANWATCH_SIGN_IDENTITY:-}"
NOTARY_PROFILE="${PANWATCH_NOTARY_PROFILE:-}"

"$SCRIPT_DIR/build.sh"
if [[ -n "$IDENTITY" ]]; then
  codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
fi
python3 - "$STAGING" "$DMG" <<'PY'
import shutil, sys
from pathlib import Path
for raw in sys.argv[1:]:
    path = Path(raw)
    if path.is_dir(): shutil.rmtree(path)
    elif path.exists(): path.unlink()
PY
mkdir -p "$STAGING"
cp -R "$APP" "$STAGING/PanWatch.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "PanWatch $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$DMG"
if [[ -n "$IDENTITY" ]]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
fi
if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi
hdiutil verify "$DMG"
shasum -a 256 "$DMG" | tee "$DMG.sha256"
cat > "$SCRIPT_DIR/build/release-notes-${VERSION}.zh-CN.md" <<EOF
# PanWatch for macOS ${VERSION}

- 架构：${ARCH}
- 安装：打开 DMG，将 PanWatch.app 拖到 Applications 文件夹。
- 连接：先启动现有 PanWatch 服务，首次打开后输入服务地址与账号。客户端不捆绑 Python 服务。
- 签名：$([[ -n "$IDENTITY" ]] && echo "Developer ID 签名" || echo "本机临时签名")
- 公证：$([[ -n "$NOTARY_PROFILE" ]] && echo "已提交并附加公证票据" || echo "未公证；跨设备分发需要 Developer ID 与公证配置")
- 校验值：见同目录 .sha256 文件。
EOF
python3 - "$STAGING" <<'PY'
import shutil, sys
from pathlib import Path
shutil.rmtree(Path(sys.argv[1]))
PY
printf 'DMG 已生成：%s\n' "$DMG"
