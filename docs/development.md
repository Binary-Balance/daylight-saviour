# Development Guide

## Supported toolchain

| Tool                  | Version           |
| --------------------- | ----------------- |
| Node.js               | 24.21.0           |
| npm                   | 11.19.0           |
| Expo                  | 57.0.31           |
| Expo Router           | 57.0.29           |
| React                 | 19.2.3            |
| React Native          | 0.86.3            |
| TypeScript            | 6.0.3             |
| Eclipse Temurin JDK   | 17.0.19+10        |
| Gradle wrapper        | 9.3.1             |
| Android Gradle Plugin | 8.12.0            |
| Android platform      | API 36            |
| Android build tools   | 35.0.0 and 36.0.0 |
| Android NDK           | 27.1.12297006     |
| CMake                 | 3.22.1            |
| Xcode                 | 26.6 (17F113)     |
| CocoaPods             | 1.17.0            |

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

Keep React Native Reanimated 4.5.1 and React Native Worklets 0.10.1 aligned across app dependencies, root overrides, and root development hoisting constraints: npm 11 otherwise materializes incompatible optional-peer copies.

Keep `jest-expo` at 57.0.5, the only version Seshat's Jest integration accepts (see [Code assurance](#code-assurance)). `expo.install.exclude` in `apps/mobile/package.json` stops Expo's version check from requiring a newer patch. Remove the exclusion when Seshat supports one ([Binary-Balance/seshat#170](https://github.com/Binary-Balance/seshat/issues/170)).

Do not use `--legacy-peer-deps`, `npm audit fix --force`, or unreviewed lifecycle-script approvals to suppress dependency problems. Resolve conflicts explicitly, document accepted advisories, and verify dependency shape with `npm run dependencies:check`.

`npm run audit` fails closed for moderate, high, and critical advisories.
`scripts/audit.mjs` lists each temporary exception with its advisory, severity
and the only installed packages allowed to depend directly on it. A new direct
dependent or a changed severity fails the audit. So does an exception that no
longer matches an advisory, so a patched release forces its removal.

The shipped `expo-router` 57.0.29 → `query-string` 7.1.3 →
`decode-uri-component` 0.2.2 chain is temporarily accepted but dormant under
standard routing: its active `getStateFromPath` fork uses `URL` and
`URLSearchParams`, while `query-string` is used to stringify paths. Externally
supplied navigation or deep-link query text can cause CPU exhaustion and client
unresponsiveness only if future app or upstream routing uses the included React
Navigation core fallback or otherwise calls `query-string.parse`. Remove this
exception when Router adopts a compatible patched parser.

Three more advisories have no patched release. Each affects only build and
test tooling, and none of these packages appears in the exported web or Android
bundle:

- `braces` 3.0.3 ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)),
  through `micromatch`: deeply nested glob patterns can exhaust the stack.
  Metro and Jest match only patterns from repository configuration.
- `node-forge` 1.4.0 ([GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)),
  through `@expo/cli` and `@expo/code-signing-certificates`: RSA PKCS#1 v1.5
  signature verification accepts extra nested digest elements, which can let
  signatures be forged for low-exponent RSA keys. The Expo CLI only verifies
  signatures it has just made or a local certificate's own signature, never
  one supplied by another party.
- `sprintf-js` 1.0.3 ([GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)),
  through `argparse`: unbounded precision specifiers can exhaust resources.
  Only js-yaml's command-line tool loads `argparse`; Jest's coverage
  configuration loader uses js-yaml's parser, so this code never runs.

Remove each exception when its package publishes a fix.

Portable signed-pack verification pins `@noble/ed25519` 3.1.0 and
`@noble/hashes` 2.2.0 in `@daylight-saviour/contracts`. Both are MIT,
zero-runtime-dependency modules. Verification wires pure JavaScript SHA
functions, so React Native needs no randomness or crypto polyfill. Node's
built-in crypto performs deterministic artifact signing.

The root `allowScripts` policy denies the optional `unrs-resolver@1.12.2` postinstall inherited through `eslint-config-expo`; repository linting works without it. The exact `fsevents@2.3.3` install script is approved for optional native macOS file watching. `strict-allow-scripts=true` makes clean installs fail before any future unreviewed lifecycle script runs. Review and pin a script before approving it.

## JDK 17

Android Gradle Plugin can run on newer JDKs, but React Native 0.86 requests a Java 17 Gradle toolchain. Use Temurin 17 rather than overriding generated upstream build configuration.

Use Linux x64 archive `OpenJDK17U-jdk_x64_linux_hotspot_17.0.19_10.tar.gz`. Verify SHA-256 before extraction:

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

## Android build architecture

Android builds must target only `arm64-v8a` by default. The Gradle command below
is for local debug validation:

```bash
NODE_ENV=development apps/mobile/android/gradlew \
  -p apps/mobile/android \
  assembleDebug \
  --no-daemon \
  -PreactNativeArchitectures=arm64-v8a
```

Any future or approved release command must also supply the
`-PreactNativeArchitectures=arm64-v8a` property.

Do not omit the architecture property. Build another architecture only when the
current work has an explicit, documented need for it, such as an `x86_64`
emulator or a release that explicitly supports that ABI. Build only the required
architecture rather than the full ABI list.

JavaScript/TypeScript changes normally need Metro, tests, typecheck, lint, and
web export only. Preserve caches unless validating reproducibility or responding
to native changes. `npm ci`, clean Expo prebuild, `gradlew clean`, native
dependency changes, and changes to Expo, React Native, Gradle, Android Gradle
Plugin, NDK, or CMake invalidate expensive build outputs.

## Browser screenshot evidence

Linux contributors can capture repeatable web evidence with distribution-managed
Chromium, ChromeDriver, and Selenium. These tools are workstation capabilities,
not product dependencies: do not add browser binaries or Selenium to this
repository.

Install and inspect the native packages:

```sh
sudo apt-get update
sudo apt-get install --yes chromium chromium-driver python3-selenium

chromium --version
/usr/bin/chromedriver --version
/usr/bin/python3 -c 'import selenium; print(selenium.__version__)'
```

Keep Chromium and ChromeDriver on matching major versions by upgrading them
together through the operating-system package manager. Use `/usr/bin/python3`
so Python loads the distribution-managed Selenium package.

Start Expo from the repository root on a fixed loopback port:

```sh
npm run web --workspace @daylight-saviour/mobile -- --port 8087 --localhost
```

Use `http://localhost:8087` for automation. On this Linux workbench, Expo has
been observed listening on IPv6 localhost while `127.0.0.1` did not connect.
The following disposable example opens the same-origin page before seeding the
persisted Home Time Zone, refreshes into the Civil Time Report, waits for semantic UI
content, and captures a mobile-sized screenshot:

```sh
/usr/bin/python3 <<'PY'
from tempfile import TemporaryDirectory

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

with TemporaryDirectory(prefix="daylight-saviour-chromium-") as profile:
    options = Options()
    options.binary_location = "/usr/bin/chromium"
    options.add_argument("--headless=new")
    options.add_argument(f"--user-data-dir={profile}")
    options.add_argument("--window-size=430,789")

    driver = webdriver.Chrome(
        service=Service("/usr/bin/chromedriver"),
        options=options,
    )
    try:
        driver.get("http://localhost:8087")
        driver.execute_script(
            "window.localStorage.setItem(arguments[0], arguments[1])",
            "home-time-zone",
            "Australia/Sydney",
        )
        driver.refresh()
        WebDriverWait(driver, 20).until(
            lambda browser: "HOME TIME ZONE"
            in browser.find_element(By.TAG_NAME, "body").text
        )
        driver.save_screenshot("/tmp/daylight-saviour-web.png")
    finally:
        driver.quit()
PY
```

Use ChromeDriver's explicit system path because Selenium Manager may not manage
distribution-packaged Chromium correctly. Run Chromium with its normal sandbox;
never add `--no-sandbox` to this workflow. The temporary profile and browser
process are cleaned when the example exits. Stop the Expo process after capture
and keep evidence free of private or environment-specific data.

Web screenshots provide fast layout evidence only. They complement rather than
replace physical-device or native-runtime validation for Android and iOS
behavior, including permissions, notifications, secure storage, and lifecycle
handling.

## Signed-pack local HTTP evidence

Run time-zone data tests with loopback listener permission. Suite generates
deterministic test-only signed artifacts in temporary directories, serves them
through reference HTTP harness, proves validators and immutable cache headers,
then closes listener:

```sh
npm run test --workspace @daylight-saviour/time-zone-data
```

No cloud deployment, production endpoint, resource identifier, or production
key participates. See `packages/time-zone-data/README.md` for manual harness
commands.

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
NODE_ENV=development apps/mobile/android/gradlew -p apps/mobile/android assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
```

Generated native directories are disposable and ignored. Regenerate after Expo
configuration or native dependency changes. All Android validation compiles only
`arm64-v8a` unless the work identifies and documents a specific need for another
architecture.

Production identifier `au.com.binarybalance.daylightsaviour` applies to both the Android application ID and iOS bundle identifier. Signing and environment-specific release configuration remain private operations concerns.

## Code assurance

[Seshat](https://github.com/Binary-Balance/seshat) measures how well the
TypeScript is tested. For each function it reports:

- **CRAP**: complexity weighted by missing branch coverage. A fully covered
  function scores its complexity, so a high CRAP means complex, untested code.
- **Cognitive complexity**: how hard the function is to follow.
- **Mutation score**: the share of small code changes (mutants), such as `<`
  to `<=`, that make a test fail. Surviving mutants show untested behaviour.
- **Pseudo-tested functions**: covered functions whose body can be removed
  without any test failing.
- **Inferred `any`**: expression sites whose type TypeScript infers as `any`,
  for example a `JSON.parse` result, so the compiler does not check them.
- **Type escapes**: `any` written in the code and `@ts-ignore`,
  `@ts-expect-error` or `@ts-nocheck` comments. Type assertions (`as`) and
  non-null assertions (`!`) are not counted.

Each area has its own configuration, so a mutant reruns only that area's tests:
`seshat.packages.json`, `seshat.notifications.json` and `seshat.mobile.json`.
All three set the same thresholds: CRAP at most 30, cognitive complexity at
most 15 and mutation score at least 80%. An area's job only warns when these
are missed until the area meets them and its `blocking` entry in the Code
assurance workflow matrix is set to true.

Each configuration also sets `maxTypeEscapes` to 0 and `maxInferredAny` to that
area's current count of inferred `any` sites. These limits block the Code
assurance job, so new `any` cannot be added. When you remove sites, lower the
area's `maxInferredAny` to the new count in the same change. Seshat keeps no
baseline, so a new site offset by a removed one still passes. The summary lists
every function with a site.

Seshat counts inferred `any` only when a setup's `typecheck` runs the compiler
directly, as `node node_modules/typescript/bin/tsc --project <config>`.
`packages/tsconfig.json` covers the four shared packages for this. An `unknown`
count, for example from a failed typecheck, makes the run incomplete. Keep
counts independent of generated files: the mobile `tsconfig.json` lists
`expo/types` in `types` instead of relying on the git-ignored `expo-env.d.ts`.

Run from root after `npm ci`:

```sh
npm run build --workspace @daylight-saviour/copy
npx --no-install seshat crap --config seshat.packages.json --json > seshat-packages.json
node scripts/seshat-summary.mjs seshat-packages.json
```

Use `check` instead of `crap` to add mutation testing. It is slow: about 15
minutes for packages on a four-core CI runner, and hours for mobile. Exit
status 0 means complete with thresholds met, 1 means a threshold was missed and
2 means the run was incomplete or invalid. For an area that is not yet
blocking, the workflow fails a status of 1 only when a type-safety limit is
missed and warns for the other thresholds.

The Code assurance workflow runs `check` for packages and `crap` for
notifications and mobile on each change, and `check` for every area weekly. The
summary appears on the workflow run, and the JSON report is kept as an
artifact.

Seshat must be able to resolve every mutant, so keep tests and modules in this
shape:

- Call product code inside tests, not while a test file or module loads. Seshat
  cannot attribute an implicit error thrown during loading, and it stops the
  run.
- Make a test fail, not hang, when awaited work never settles. Seshat treats a
  timeout as unresolved and withholds the mutation score.
