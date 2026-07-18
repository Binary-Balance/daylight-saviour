# Repository Guidelines

## Architecture & Project Structure

Daylight Saviour uses Expo, React Native, and strict TypeScript for Android, iOS, and web. Follow the reading order in [`docs/README.md`](docs/README.md) before changing architecture. [`CONTEXT.md`](CONTEXT.md) is the domain glossary, not a project-status ledger; use public issues for current delivery state.

Use Expo Router routes under `apps/mobile/app/`. Keep mobile UI in `apps/mobile/components/`, feature logic in `apps/mobile/src/features/<feature>/`, notification code in `services/notifications/`, shared domain/contracts/copy/data tooling in `packages/`, and generic Bicep in `infra/modules/`. Place tests beside subjects as `*.test.ts(x)`. Treat generated `android/` and `ios/` directories as disposable output unless an ADR changes that policy.

## Delivery Tracking

[Public product issues](https://github.com/Binary-Balance/daylight-saviour/issues) are execution source for this repository. Agents may start only open issues labelled `ready-for-agent`; never start `blocked` or `human-action` issues. Keep issue acceptance criteria, dependency relationships, labels, and milestones accurate.

## Repository Boundary — Mandatory

Classify work before creating an issue or editing files.

**Public `daylight-saviour` owns:** Expo app; notification-service source; time-zone generator and packs; shared domain, contracts, copy, and fixtures; generic reusable Bicep modules; tests; public CI; public site; product, architecture, privacy, security, and contributor documentation.

**Private `daylight-saviour-ops` owns:** publisher-account work; real Azure compositions and parameters; tenant/subscription/principal IDs; actual resource names and endpoints; OIDC and RBAC assignments; Key Vault secret provisioning; APNs, FCM, store, and signing configuration; privileged deployment/release workflows; private brand source; operational evidence, alerts, and runbooks.

Cross-repository work must be split into paired issues. Public issue describes portable product capability only; private issue applies it to real environments. Private issue may link public issue. Public issue must not link or quote private issue. If uncertain, create private issue and request classification. Never move private identifiers, logs, screenshots, or issue text into public commits, pull requests, Actions, or discussions.

## Development, Build & Validation

After Expo scaffold exists, run from repository root:

- `npm ci` — install from lockfile.
- `npx expo start` — run Metro for device or simulator development.
- `npx expo start --web` — run browser preview.
- `npm run typecheck` — validate strict TypeScript.
- `npm run lint` — run configured ESLint checks.
- `npm test` — run unit and component tests.
- `npx expo-doctor` — check Expo dependency and project compatibility.
- `npx expo export --platform web` — verify web bundle.
- `npx expo prebuild --clean` — regenerate native projects.

Linux supports web and Android after Android tooling is installed. iOS builds run on GitHub-hosted macOS runners. Do not introduce EAS without revisiting ADR 0001.

## Android Build Cost

Routine Android validation compiles only `arm64-v8a`; full four-ABI compilation is reserved for release validation and major native or toolchain changes. JavaScript/TypeScript UI work should use Metro, tests, typecheck, lint, and web export without a native build unless behavior crosses the native boundary.

Preserve native build caches during ordinary work. `npm ci` replaces `node_modules` and dependency-local CMake outputs; clean Expo prebuild replaces generated app-native outputs; `gradlew clean` removes Gradle outputs. Use clean operations for reproducibility, lockfile or native configuration changes, or explicit evidence—not every edit. CI caches Gradle and performs an arm64-only debug build. See `docs/development.md` for commands and measured profiles.

## Dependency Management

Use npm workspaces and the single root `package-lock.json`. Never commit nested lockfiles or run workspace-local installs that create a second dependency tree. CI and clean verification use `npm ci` from repository root.

Put dependencies in the workspace that imports them. Root `devDependencies` are only for genuinely repository-wide tools. Mobile-only test packages, React renderers, Expo modules, and native dependencies belong in `apps/mobile/package.json`; service or shared-package dependencies belong to their owning workspace.

Treat React and native modules as singletons. Keep `react`, `react-dom`, and `react-test-renderer` on the exact versions selected by the current Expo SDK, and mirror those versions in root npm `overrides` to prevent peer auto-install drift. Never accept duplicate React or native-module versions. After dependency changes, run `npm ls react react-dom react-test-renderer`, `npm dedupe`, Expo Doctor, typecheck, lint, tests, and relevant exports/builds.

Use the project-local Expo CLI and `expo install` when adding or upgrading Expo/native packages so versions follow the installed SDK compatibility map. Inspect every manifest and lockfile diff. Prefer exact direct dependency versions; retain Expo-generated compatible ranges only where Expo deliberately manages them. Upgrade Expo SDKs as focused changes, then realign singleton overrides and regenerate native projects.

Do not use `--legacy-peer-deps`, `npm audit fix --force`, unreviewed install-script approval, or broad opportunistic upgrades. Resolve peer conflicts explicitly. Review lifecycle scripts and package provenance before allowing them. Security fixes should identify affected runtime path, choose a compatible direct upgrade or override, and rerun the complete validation matrix.

## Coding Style & Naming

Use two-space indentation and formatter defaults. Components and types use `PascalCase`; functions, hooks, and variables use `camelCase`; hooks start with `use`; route and asset files use lowercase kebab-case where Expo Router permits. Prefer small feature-owned modules over generic utility collections. Keep platform-specific implementations explicit with `.ios.ts(x)`, `.android.ts(x)`, or `.web.ts(x)` suffixes.

## Testing

Test observable behavior. Cover domain logic with unit tests and screens with React Native Testing Library. Add regression tests for bug fixes. Keep time, network, filesystem, and device APIs deterministic through injected boundaries or mocks. Critical journeys require hosted-runner device smoke tests before release.

## Commits & Pull Requests

Use concise imperative subjects, for example `Add daylight offset calculator`. Keep commits focused. Pull requests must explain purpose, link relevant issues, list verification commands, and include screenshots for UI changes. Call out native configuration, permissions, migrations, and Azure infrastructure changes.

## CI/CD & Security

GitHub Actions is the CI/CD system. Untrusted public pull requests run only on isolated GitHub-hosted runners; never run them on this Azure VM. Azure deployment controls for every environment follow ADR 0004: separate least-privilege branch-bound OIDC identities, manual apply, same-commit reviewed what-if evidence, and explicit confirmation. Never claim protected-branch or protected-environment enforcement while the current GitHub plan lacks it. Never commit credentials, signing keys, generated secrets, or `.env` files; provide sanitized `.env.example` entries instead.
