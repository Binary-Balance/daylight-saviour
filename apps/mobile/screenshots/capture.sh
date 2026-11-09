#!/usr/bin/env bash
# Runs every screen flow in light and dark appearance at the default text size.
# It leaves the device in dark appearance with a fixed status bar.
# Usage: capture.sh <android|ios> <device-name> <output-directory>
# Maestro's own reports, useful when a flow fails, go in maestro-reports
# beside the output directory. Expects one booted emulator or simulator with
# the development build installed, and Metro running with
# EXPO_PUBLIC_SCREENSHOT_MODE=true.
set -euo pipefail

platform=$1
device=$2
mkdir -p "$3"
output=$(cd "$3" && pwd)
reports=$(dirname "$output")/maestro-reports
flows=$(dirname "$0")
# Maestro adds a folder per run, so an earlier run's screenshots would
# otherwise be collected too.
rm -rf "$reports"

case "$platform" in
  android)
    evidence=emulator
    adb shell settings put system font_scale 1.0
    adb shell settings put global sysui_demo_allowed 1
    ;;
  ios)
    evidence=simulator
    # Large is the iOS default text size.
    xcrun simctl ui booted content_size large
    xcrun simctl status_bar booted override --time 9:41
    ;;
  *)
    echo "Unknown platform: $platform" >&2
    exit 1
    ;;
esac

run_flows() {
  if [ "$platform" = android ]; then
    # Reconnecting loses the reverse mapping the app uses to reach Metro.
    adb wait-for-device
    adb reverse tcp:8081 tcp:8081 || return
  fi
  maestro test \
    --env "PREFIX=$platform-$device-$1-text-default-$evidence" \
    --test-output-dir "$reports/$1" \
    "$flows"
}

for appearance in light dark; do
  if [ "$platform" = android ]; then
    adb shell cmd uimode night "$([ "$appearance" = dark ] && echo yes || echo no)"
    # A slow emulator's System UI can stop responding while it redraws for
    # the new appearance, and its dialog would cover the app.
    sleep 10
    adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS
    # Demo mode shows a fixed clock and hides notification icons. Hosted
    # emulators dropped it when it was entered before the appearance change.
    adb shell am broadcast -a com.android.systemui.demo -e command enter
    adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
    adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
  else
    xcrun simctl ui booted appearance "$appearance"
  fi
  # A hosted emulator once dropped its adb connection between two flows.
  run_flows "$appearance" || run_flows "$appearance"
done
# Maestro keeps each flow's screenshots in its own report folder.
find "$reports" -path '*/takeScreenshot/*.png' -exec mv {} "$output" \;
