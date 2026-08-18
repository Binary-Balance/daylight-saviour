# Portable infrastructure

Only generic reusable Bicep modules belong in this public directory. Real Azure compositions, parameters, identifiers, deployed names, and privileged workflows belong in the private operations repository.

[`modules/minimal-functions-platform.bicep`](modules/minimal-functions-platform.bicep) is the external seam for a minimal Azure Functions notification platform. Callers supply approved names and settings; internal orchestration remains private to the module implementation.

Optional FCM settings contain identifiers only. Reserved deployment inputs,
reusable keyless sender primitives, and least-privilege grants are documented in
[notification service](../services/notifications/README.md).
