---
status: accepted
---

# Use a TypeScript monorepo for product services

The public product repository will use strict TypeScript across the Expo mobile app, Azure Functions notification service, time-zone data generator, shared domain logic, runtime-validated contracts, and reviewed copy catalogue. npm workspaces will organise deployable apps and dependency-light shared packages; Bicep remains the infrastructure language.

## Consequences

- Proposed top-level structure is `apps/mobile`, `services/notifications`, `packages/*`, and `infra/modules`.
- Network, storage, and downloaded-data boundaries require runtime validation rather than TypeScript types alone.
- Shared packages remain independent of React Native and Azure Functions unless explicitly platform-specific.
- App and service tests use compatible TypeScript tooling and share domain fixtures.
