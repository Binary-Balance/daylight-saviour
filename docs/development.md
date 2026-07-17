# Development Guide

## Supported toolchain

| Tool                   | Version           |
| ---------------------- | ----------------- |
| Node.js                | 24.18.0           |
| npm                    | 11.16.0           |
| Expo                   | 57.0.4            |
| React                  | 19.2.3            |
| React Native           | 0.86.0            |
| TypeScript             | 6.0.3             |
| Eclipse Temurin JDK    | 17.0.19+10        |
| Gradle wrapper         | 9.3.1             |
| Android Gradle Plugin  | 8.12.0            |
| Android platform       | API 36            |
| Android build tools    | 35.0.0 and 36.0.0 |
| Android platform tools | 37.0.0            |
| Android NDK            | 27.1.12297006     |
| CMake                  | 3.22.1            |

`.nvmrc`, `package.json`, `package-lock.json`, Expo configuration, and generated Gradle files are authoritative. Update this table in the same pull request when changing them.

## Dependency management

This repository uses one npm workspace install and one root `package-lock.json`.

```sh
npm ci
npm install <package> --workspace <workspace-name> --save-exact
npm install <dev-package> --workspace <workspace-name> --save-dev --save-exact
npm exec --workspace=@daylight-saviour/mobile -- expo install <expo-package>
```

Add each dependency to its consuming workspace. Keep React, React DOM, and React Test Renderer exact and aligned with root overrides. Do not run installs inside workspace directories or commit nested lockfiles.

Do not use `--legacy-peer-deps`, `npm audit fix --force`, or unreviewed lifecycle-script approvals to suppress dependency problems. Resolve conflicts explicitly, document accepted advisories, and verify dependency shape with `npm run dependencies:check`.

Root override `uuid@11.1.1` patches the version requested by Expo's transitive `xcode@3.0.1` tooling. `xcode` uses the retained `uuid.v4()` API. Keep native generation in validation and remove this override when Expo's dependency chain adopts a patched version directly.

The root `allowScripts` policy denies the optional `unrs-resolver@1.12.2` postinstall inherited through `eslint-config-expo`; repository linting works without it. The exact `fsevents@2.3.3` install script is approved for optional native macOS file watching. `strict-allow-scripts=true` makes clean installs fail before any future unreviewed lifecycle script runs. Review and pin a script before approving it.

## JDK 17

Android Gradle Plugin can run on newer JDKs, but React Native 0.86 requests a Java 17 Gradle toolchain. Use Temurin 17 rather than overriding generated upstream build configuration.

The current Linux x64 archive is `OpenJDK17U-jdk_x64_linux_hotspot_17.0.19_10.tar.gz`. Verify SHA-256 before extraction:

```text
d8afc263758141a66e0e3aafc321e783f7016696f4eaea067d340a269037d331
```

Install under a user-owned JDK directory and expose it through `JAVA_HOME`:

```sh
export JAVA_HOME="$HOME/.local/share/jdks/temurin-17"
export PATH="$JAVA_HOME/bin:$PATH"
```

## Android SDK

Install Android command-line tools 20.0 from `commandlinetools-linux-14742923_latest.zip`. Published SHA-1 and observed SHA-256 checksums:

```text
SHA-1   48833c34b761c10cb20bcd16582129395d121b27
SHA-256 04453066b540409d975c676d781da1477479dde3761310f1a7eb92a1dfb15af7
```

Place tools at `$ANDROID_HOME/cmdline-tools/latest`, accept standard Android SDK licence, then install pinned packages:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;35.0.0" \
  "build-tools;36.0.0" \
  "ndk;27.1.12297006" \
  "cmake;3.22.1"
```

No emulator or system image is required for compilation. Runtime testing can use a physical Android device or later CI/device infrastructure. iOS compilation uses hosted macOS infrastructure.

## Android build profiles

Routine CI and local APK validation compile only `arm64-v8a`:

```bash
NODE_ENV=development apps/mobile/android/gradlew \
  -p apps/mobile/android \
  assembleDebug \
  --no-daemon \
  -PreactNativeArchitectures=arm64-v8a
```

Full release-oriented validation builds all configured ABIs by omitting the architecture property:

```bash
NODE_ENV=development apps/mobile/android/gradlew \
  -p apps/mobile/android \
  assembleDebug \
  --no-daemon
```

Reference measurements on the two-vCPU, 7.7 GiB RAM development VM:

- Cold four-ABI build: 1 hour 4 minutes 30 seconds.
- Clean arm64-only build: 18 minutes 9 seconds.
- Unchanged warm arm64-only build: 1 minute 43 seconds; 403 of 422 Gradle tasks reused.

Full clean multi-ABI builds are release or major native-toolchain checks, not routine development. JavaScript/TypeScript changes normally need Metro, tests, typecheck, lint, and web export only. Preserve caches unless validating reproducibility or responding to native changes. `npm ci`, clean Expo prebuild, `gradlew clean`, native dependency changes, and changes to Expo, React Native, Gradle, Android Gradle Plugin, NDK, or CMake invalidate expensive build outputs.

## Validation

Run repository checks from root:

```sh
npm run format:check
npm run audit
npm run typecheck
npm run lint
npm test
npm run dependencies:check
npm run web:export
npm run native:generate:android
NODE_ENV=development apps/mobile/android/gradlew -p apps/mobile/android assembleDebug --no-daemon
```

Generated native directories are disposable and ignored. Regenerate after Expo configuration or native dependency changes. Routine CI compiles `arm64-v8a`; release validation must restore every supported ABI.

Production identifier `au.com.binarybalance.daylightsaviour` applies to both the Android application ID and iOS bundle identifier. Signing and environment-specific release configuration remain private operations concerns.
