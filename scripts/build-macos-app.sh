#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${ONLY_CHAT_APP_PATH:-$HOME/Applications/Only Chat.app}"
APP_BUNDLE_ID="${ONLY_CHAT_BUNDLE_ID:-com.rogan.onlychat}"
APP_SERVER_PORT="${ONLY_CHAT_SERVER_PORT:-8899}"
PREVIEW_ISOLATED="${ONLY_CHAT_ISOLATED_PREVIEW:-0}"
PREVIEW_DATA_DIR="${ONLY_CHAT_PREVIEW_DATA_DIR:-}"
THREEF_SOURCE_ROOT="${THREEF_SOURCE_ROOT:-$HOME/appDev/apps/3f-browser-mac/Sources/ThreeFBrowser}"
NODE_BIN=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done

if [ -z "$NODE_BIN" ]; then
  echo "Node.js is required to run Only Chat on this Mac." >&2
  exit 1
fi
APP_VERSION="$("$NODE_BIN" -p "require('$ROOT/package.json').version")"
if [ -e "$APP" ]; then
  echo "Refusing to replace existing app: $APP" >&2
  exit 1
fi
if ! [[ "$APP_SERVER_PORT" =~ ^[0-9]+$ ]] || [ "$APP_SERVER_PORT" -lt 1 ] || [ "$APP_SERVER_PORT" -gt 65535 ]; then
  echo "Invalid Only Chat server port: $APP_SERVER_PORT" >&2
  exit 1
fi
if [ "$PREVIEW_ISOLATED" = "1" ] && { [ -z "$PREVIEW_DATA_DIR" ] || [[ "$PREVIEW_DATA_DIR" != /tmp/* ]]; }; then
  echo "An isolated preview requires ONLY_CHAT_PREVIEW_DATA_DIR inside /tmp." >&2
  exit 1
fi

mkdir -p "$HOME/Applications" "$APP/Contents/MacOS" "$APP/Contents/Resources"
build_complete=0
cleanup() {
  if [ "$build_complete" -ne 1 ]; then rm -rf "$APP"; fi
}
trap cleanup EXIT INT TERM

ICONSET="$APP/Contents/Resources/OnlyChat.iconset"
mkdir -p "$ICONSET"
swiftc -swift-version 5 -framework Security \
  "$ROOT/macOS/NotionCredentialBridge.swift" \
  -o "$APP/Contents/Resources/OnlyChatCredentialBridge"
cp "$THREEF_SOURCE_ROOT/Resources/Readability.js" "$APP/Contents/Resources/Readability.js"
cp "$THREEF_SOURCE_ROOT/Resources/Readability-LICENSE" "$APP/Contents/Resources/Readability-LICENSE"
python3 - "$ICONSET" <<'PY'
import pathlib, sys
from PIL import Image, ImageDraw

out = pathlib.Path(sys.argv[1])
for size in (16, 32, 64, 128, 256, 512):
    scale = 2 if size <= 256 else 1
    px = size * scale
    image = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = px * 0.08
    draw.rounded_rectangle((pad, pad, px-pad, px-pad), radius=px*0.23, fill='#f06a35')
    # White conversation balloon with a clear tail and three orange typing dots.
    x0, y0, x1, y1 = px*0.22, px*0.25, px*0.78, px*0.68
    draw.rounded_rectangle((x0, y0, x1, y1), radius=px*0.11, fill='white')
    draw.polygon([(px*0.34, y1-px*0.02), (px*0.31, px*0.78), (px*0.48, y1-px*0.02)], fill='white')
    for x in (px*0.39, px*0.50, px*0.61):
        r = px*0.028
        draw.ellipse((x-r, px*0.465-r, x+r, px*0.465+r), fill='#f06a35')
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / f'icon_{size}x{size}.png')
    image.resize((size*2, size*2), Image.Resampling.LANCZOS).save(out / f'icon_{size}x{size}@2x.png')
PY
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/OnlyChat.icns"
rm -rf "$ICONSET"

swiftc -parse-as-library -swift-version 5 -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework ImageIO -framework ScreenCaptureKit -framework WebKit -framework Speech -framework AVFoundation \
  "$ROOT/macOS/OnlyChatApp.swift" \
  "$ROOT/macOS/ThreeFBrowserResourceBundle.swift" \
  "$THREEF_SOURCE_ROOT/OptionalFeatureAvailability.swift" \
  "$THREEF_SOURCE_ROOT/AddressBarNavigationRequest.swift" \
  "$THREEF_SOURCE_ROOT/BrowserNavigationURLSync.swift" \
  "$THREEF_SOURCE_ROOT/BrowserTabSelectionPolicy.swift" \
  "$THREEF_SOURCE_ROOT/BrowserContextMenu.swift" \
  "$THREEF_SOURCE_ROOT/BrowserKeyboardCommands.swift" \
  "$THREEF_SOURCE_ROOT/BrowserModel.swift" \
  "$THREEF_SOURCE_ROOT/BrowserSessionStore.swift" \
  "$THREEF_SOURCE_ROOT/BookmarkHTML.swift" \
  "$THREEF_SOURCE_ROOT/ReaderArticle.swift" \
  "$THREEF_SOURCE_ROOT/ReaderModeView.swift" \
  "$THREEF_SOURCE_ROOT/BrowserSettingsView.swift" \
  "$THREEF_SOURCE_ROOT/DefaultBrowserService.swift" \
  "$THREEF_SOURCE_ROOT/BrowserView.swift" \
  "$THREEF_SOURCE_ROOT/MediaSiteCandidate.swift" \
  "$THREEF_SOURCE_ROOT/MediaSiteCandidateSheet.swift" \
  "$THREEF_SOURCE_ROOT/MediaSiteSnoozeStore.swift" \
  "$THREEF_SOURCE_ROOT/BrowserWebView.swift" \
  "$THREEF_SOURCE_ROOT/EmbeddedBrowserSession.swift" \
  "$THREEF_SOURCE_ROOT/ExtensionCompatibility.swift" \
  "$THREEF_SOURCE_ROOT/FocusFenceConnectionService.swift" \
  "$THREEF_SOURCE_ROOT/FocusFenceSearchResultFilter.swift" \
  "$THREEF_SOURCE_ROOT/GoogleOAuthNavigationPolicy.swift" \
  "$THREEF_SOURCE_ROOT/HotModuleStore.swift" \
  "$THREEF_SOURCE_ROOT/YouTubePreviewPlaybackBlocker.swift" \
  "$THREEF_SOURCE_ROOT/ThreeFURLRouter.swift" \
  "$THREEF_SOURCE_ROOT/ThreeFBrowserControl.swift" \
  "$THREEF_SOURCE_ROOT/YouTubeUsageReporter.swift" \
  "$THREEF_SOURCE_ROOT/YouTubeUsageSummary.swift" \
  -o "$APP/Contents/MacOS/OnlyChat"
printf '%s\n' "$ROOT" > "$APP/Contents/Resources/project-root.txt"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>OnlyChat</string>
  <key>CFBundleIdentifier</key><string>$APP_BUNDLE_ID</string>
  <key>CFBundleName</key><string>Only Chat</string>
  <key>CFBundleDisplayName</key><string>Only Chat</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>OnlyChat</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>OnlyChatServerPort</key><integer>$APP_SERVER_PORT</integer>
  <key>NSScreenCaptureUsageDescription</key><string>Only Chat captures the current display only when you enable Mac screen control and request a screen view.</string>
  <key>OnlyChatIsolatedPreview</key><$([ "$PREVIEW_ISOLATED" = "1" ] && echo true || echo false)/>
  <key>OnlyChatPreviewDataDirectory</key><string>$PREVIEW_DATA_DIR</string>
  <key>OnlyChatDiagnosticLogPath</key><string>${PREVIEW_DATA_DIR:+$PREVIEW_DATA_DIR/server.log}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSpeechRecognitionUsageDescription</key><string>Only Chat uses speech recognition to turn your spoken words into text in the chat composer.</string>
  <key>NSMicrophoneUsageDescription</key><string>Only Chat records audio only while you tap the voice memo button; transcription runs locally on this Mac.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
"$HOME/.codex/bin/workflow-control" verify-mac "$APP"
build_complete=1
trap - EXIT INT TERM
echo "Built: $APP"
echo "Node runtime: $NODE_BIN"
