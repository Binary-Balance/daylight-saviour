#!/usr/bin/env bash
# Runs every screen flow in light and dark appearance at the default text size.
# Usage: capture.sh <android|ios> <device-name> <output-directory>
# Maestro's own reports, useful when a flow fails, go in maestro-reports
# beside the output directory. Expects one booted emulator or simulator with
# the development build installed, and Metro running with
# EXPO_PUBLIC_SCREENSHOT_MODE=true.
set -euo pipefail

platform=$1
device=$2
output=$(realpath -m "$3")
reports=$(dirname "$output")/maestro-reports
flows=$(dirname "$0")

case "$platform" in
  android)
    evidence=emulator
    adb shell settings put system font_scale 1.0
    # Demo mode shows a fixed clock and hides notification icons.
    adb shell settings put global sysui_demo_allowed 1
    adb shell am broadcast -a com.android.systemui.demo -e command enter
    adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
    adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
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

mkdir -p "$output"
for appearance in light dark; do
  if [ "$platform" = android ]; then
    adb shell cmd uimode night "$([ "$appearance" = dark ] && echo yes || echo no)"
    # A slow emulator's System UI can stop responding while it redraws for
    # the new appearance, and its dialog would cover the app.
    sleep 10
    adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS
  else
    xcrun simctl ui booted appearance "$appearance"
  fi
  maestro test \
    --env "PREFIX=$platform-$device-$appearance-text-default-$evidence" \
    --test-output-dir "$reports/$appearance" \
    "$flows"
done
# Maestro keeps each flow's screenshots in its own report folder.
find "$reports" -path '*/takeScreenshot/*.png' -exec mv {} "$output" \;
