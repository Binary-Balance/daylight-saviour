# Android FCM proof builds

This build path creates a self-contained, `arm64-v8a` release APK for direct
physical-device FCM testing. It does not use Expo Go, EAS, or a remote Metro
server. Real Firebase configuration, runtime environment values, and signing
material remain private operations inputs.

## Inputs and validation

Review these inputs in the private build environment before starting:

- `DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE` — absolute path to a
  `google-services.json` file held outside the public checkout. Expo native
  generation copies it into ignored generated Android output.
- `EXPO_PUBLIC_REMINDER_REGISTRATION_URL` — reviewed, credential-free HTTPS
  registration-service URL.
- Optional remote Time-Zone Data pair:
  - `EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL` — reviewed Time-Zone Data Pack
    credential-free HTTPS manifest URL without query or fragment.
  - `EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON` — reviewed public
    verification-key JSON using canonical base64-encoded 32-byte Ed25519 keys.

`EXPO_PUBLIC_*` values are public application configuration, not secrets. Expo
inlines them while Gradle creates the JavaScript bundle. Do not print their
values into public logs or evidence because production identifiers remain
private operations data.

`npm run android:build:fcm-proof` sets
`DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD=1`. Native generation then fails unless the
Firebase file exists, contains valid JSON, and has an Android client for exactly
`au.com.binarybalance.daylightsaviour`. It also fails when the reviewed reminder
registration URL is absent or invalid. Remote Time-Zone Data inputs must either
both be present and valid or both be absent. Build validation uses the same URL,
JSON, key-ID, and Ed25519 public-key parser as mobile runtime configuration. When
both are absent, the app uses its bundled known-good pack and disables network
refresh. Ordinary public CI needs no Firebase file and keeps the FCM proof flag
unset.

## Build

Start from a reviewed, clean commit. Export required inputs and either both or
neither optional remote Time-Zone Data inputs from the private build environment
without copying them into the checkout, then run:

```sh
npm run android:build:fcm-proof
```

The command performs a clean Expo Android generation, embeds JavaScript and
assets during `assembleRelease`, and compiles only `arm64-v8a`. Output:

```text
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Expo's generated project signs this direct-test release APK with its generated
debug signing configuration unless private operations injects another signing
configuration into the ignored native project. Record the actual certificate
provenance. A debug-signed APK is suitable for direct physical-device proof but
is not eligible for store promotion.

## Verify and install

Set `ANDROID_HOME` as described in [development guide](development.md), then
inspect without exposing configuration values:

```sh
APK=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
sha256sum "$APK"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$APK"
"$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest application-id "$APK"
"$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest version-name "$APK"
"$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest version-code "$APK"
unzip -l "$APK" | grep 'assets/index.android.bundle'
adb install -r "$APK"
```

Expected application ID:
`au.com.binarybalance.daylightsaviour`. Presence of
`assets/index.android.bundle` confirms JavaScript is packaged for launch without
Expo Go or Metro. Physical-device notification delivery remains required
runtime evidence; compilation alone does not prove registration or FCM receipt.

## Evidence record

Store operational evidence privately. Record:

```text
Source commit: <40-character public commit SHA>
APK SHA-256: <64 lowercase hexadecimal characters>
Application ID: au.com.binarybalance.daylightsaviour
Version name: <manifest value>
Version code: <manifest value>
Signing provenance: <debug or approved release source; certificate SHA-256>
Reviewed runtime inputs: <variable names and private review reference; no values>
Firebase input provenance: <private review reference; no file or identifiers>
Promotion eligible: <yes/no and reason>
Device proof: <device/OS class, UTC time, outcome; no device token>
```

Never attach or paste Firebase configuration, signing material, installation
credentials, device tokens, or expanded `EXPO_PUBLIC_*` values. Artifact
promotion requires eligible signing, immutable source provenance, and the
separate release gates in
[ADR 0011](adr/0011-promote-tested-store-builds.md); this proof build does not
grant promotion eligibility by itself.
