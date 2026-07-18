# Documentation index

This index is the canonical entry point for public Daylight Saviour documentation. It covers portable product and engineering context only. Current delivery state belongs in [public GitHub issues](https://github.com/Binary-Balance/daylight-saviour/issues), not narrative context documents.

## Reading order

1. [Repository guidelines](../AGENTS.md) — mandatory delivery, repository-boundary, development, and security rules.
2. [Project README](../README.md) — product summary, repository scope, and common validation.
3. [Product brief](product-brief.md) — accepted product direction and MVP scope.
4. [UI design brief](ui-design-brief.md) — accepted interaction, visual, motion, state, and accessibility direction.
5. [Domain glossary](../CONTEXT.md) — canonical terms used across code, documentation, and issues; not an implementation-status ledger.
6. [Architecture decisions](#architecture-decisions) — accepted technical and product constraints relevant to planned work.
7. [Development guide](development.md) — pinned toolchain, dependency policy, builds, and validation commands.

Before implementing an issue, read its acceptance criteria and dependencies, then revisit relevant decisions below. Public issues describe portable capability only; environment-specific operations remain outside this repository.

## Architecture decisions

Every ADR is currently accepted. Status is recorded in each ADR's front matter.

### Platform, repository, and delivery

- [ADR 0001: Use Expo, GitHub Actions, and optional Azure infrastructure](adr/0001-expo-github-actions-azure.md)
- [ADR 0004: Manage Azure infrastructure with Bicep Deployment Stacks](adr/0004-manage-azure-with-bicep-deployment-stacks.md)
- [ADR 0005: Separate public product and private operations](adr/0005-separate-public-product-and-private-operations.md)
- [ADR 0007: License public source under Apache-2.0](adr/0007-license-public-source-under-apache-2.md)
- [ADR 0008: Use a TypeScript monorepo for product services](adr/0008-use-typescript-monorepo-for-product-services.md)
- [ADR 0011: Promote tested store builds without rebuilding](adr/0011-promote-tested-store-builds.md)

### Civil time and data

- [ADR 0002: Distribute time-zone data independently of app releases](adr/0002-distribute-time-zone-data-remotely.md)
- [ADR 0012: Require alerted human review for time-zone data promotion](adr/0012-require-alerted-review-for-time-zone-data.md)
- [ADR 0015: Make civil-time correctness a release gate](adr/0015-make-civil-time-correctness-a-release-gate.md)
- [ADR 0019: Calculate countdowns between instants](adr/0019-calculate-countdowns-between-instants.md)
- [ADR 0021: Present reviewed geographic labels for time zones](adr/0021-present-reviewed-geographic-zone-labels.md)

### Reminders, privacy, and service security

- [ADR 0003: Send Change Reminders remotely from Azure](adr/0003-send-change-reminders-remotely-from-azure.md)
- [ADR 0006: Minimise user data and client telemetry](adr/0006-minimise-user-data-and-client-telemetry.md)
- [ADR 0009: Use a minimal serverless Azure footprint](adr/0009-use-minimal-serverless-azure-footprint.md)
- [ADR 0010: Protect registration with installation credentials](adr/0010-protect-registration-with-installation-credentials.md)
- [ADR 0016: Provide an audited reminder dispatch kill switch](adr/0016-provide-a-reminder-dispatch-kill-switch.md)

### Product experience and release quality

- [ADR 0013: Make accessibility a release gate](adr/0013-make-accessibility-a-release-gate.md)
- [ADR 0014: Launch in Australian English with localization boundaries](adr/0014-launch-in-australian-english.md)
- [ADR 0017: Use low-infrastructure support channels](adr/0017-use-low-infrastructure-support-channels.md)
- [ADR 0018: Use a bureaucratic-modernist visual language](adr/0018-use-bureaucratic-modernist-visual-language.md)
- [ADR 0020: Use a Living Dossier instead of artificial engagement](adr/0020-use-a-living-civil-time-dossier.md)

## Component documentation

- [Portable infrastructure](../infra/README.md) and [generic Bicep module contract](../infra/modules/README.md)
- [Runtime-validated contracts](../packages/contracts/README.md)
- [Reviewed copy](../packages/copy/README.md)
- [Time-zone data](../packages/time-zone-data/README.md)

Source-adjacent README files document component seams. If one conflicts with an accepted ADR, update both deliberately or record a superseding decision.
