---
status: accepted
---

# Use Expo, GitHub Actions, and optional Azure infrastructure

Daylight Saviour will use Expo with React Native and TypeScript for cross-platform Android, iOS, and web development. Product source will live in a public GitHub repository, with GitHub Actions providing CI on hosted Linux and macOS runners. Privileged release and Azure deployment automation will live in a private operations repository as refined by ADR 0005. EAS will not be an initial build or deployment dependency.

## Rationale

Expo gives a coding agent a strong feedback loop: widely represented React and TypeScript APIs, strict static checks, fast refresh, browser preview, automated tests, and declarative native configuration. Expo retains access to native Android and iOS capabilities through React Native modules and generated native projects.

GitHub best matches an open-source project. Repository discovery, issues, pull requests, Actions results, releases, and contributor workflows remain in one public system. Standard GitHub-hosted runners support Linux Android builds and required macOS iOS builds without maintaining build machines. GitHub Actions can deploy to Azure using short-lived OIDC credentials, so Azure hosting does not require Azure DevOps or stored service-principal secrets.

Existing Azure DevOps experience from Binary Balance remains useful for pipeline structure: path filters, staged validation, Bicep what-if, environment approvals, deployment artifacts, and scheduled work. Those patterns can be translated into GitHub Actions without splitting contributor activity across GitHub and Azure DevOps.

## Considered Options

- **Azure DevOps Pipelines:** capable and familiar, but divides public contributor experience and requires a public Azure DevOps project for its public-project hosted-runner grant.
- **EAS Build and Workflows:** lower operational effort, but adds a hosted service where GitHub runners can provide required builds and automation. Reconsider if signing, store submission, build distribution, or OTA updates become costly to maintain.
- **Flutter, Capacitor, or Rust-native UI:** viable for narrower needs, but Expo offers the best overall combination of native capability, ecosystem depth, agent familiarity, and testable feedback.

## Consequences

- Linux workbench handles TypeScript development, web preview, tests, and Android builds after Android tooling is installed; iOS compilation runs on GitHub-hosted macOS runners.
- CI owns Android/iOS toolchain setup, signing, artifacts, and store-delivery automation.
- Public pull requests run only on isolated GitHub-hosted runners. This Azure VM must not execute untrusted fork code as a general self-hosted runner.
- Azure resources, if introduced, use infrastructure as code and workload identity federation with least-privilege deployment identities.
- Architecture remains portable: Expo can build outside EAS, and backend hosting is not coupled to Expo or GitHub.
