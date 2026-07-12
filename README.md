# Daylight Saviour

Daylight Saviour is a polished, playful Android and iOS app explaining whether daylight saving currently applies in an Australian Home Time Zone and what clocks will do next.

## Project Status

Product direction and architecture are documented in [product brief](docs/product-brief.md), [UI design brief](docs/ui-design-brief.md), [domain glossary](CONTEXT.md), and [architecture decisions](docs/adr/). Implementation work is tracked through [GitHub issues](https://github.com/Binary-Balance/daylight-saviour/issues). The `ready-for-agent` label means an issue is sufficiently specified; agents may start only [ready issues without the `blocked` label](https://github.com/Binary-Balance/daylight-saviour/issues?q=is%3Aissue%20state%3Aopen%20label%3Aready-for-agent%20-label%3Ablocked).

## Repository Boundary

This public repository owns portable product work: Expo app, notification-service source, time-zone tooling and data contracts, shared domain and copy, generic Bicep modules, tests, public CI/site, and technical documentation.

Environment-specific Azure composition, deployed identifiers, privileged workflows, signing/store configuration, private brand source, and operational evidence live in a separate private operations repository. Secrets are never committed to either repository.

Read [AGENTS.md](AGENTS.md) before contributing. It defines mandatory issue-routing and confidentiality boundaries.

## Licence

Code and technical documentation are licensed under Apache-2.0. The Daylight Saviour name, app icon, store artwork, and distinctive product identity remain reserved; see forthcoming trademark notice before redistributing branded builds.
