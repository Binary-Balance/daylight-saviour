---
status: accepted
---

# Separate public product source from private operations

Daylight Saviour will use a public product repository and a private `daylight-saviour-ops` repository. The public repository will contain the Expo app, notification-service source, generic Bicep modules, tests, contracts, and unprivileged CI; the private repository will contain real environment compositions and parameters, tenant and subscription identifiers, actual resource names, privileged deployment and release workflows, and operational runbooks.

## Consequences

- Private workflows check out an exact public tag or commit before building, signing, or deploying it.
- Credentials remain in Azure Key Vault; neither repository stores secret values.
- Public workflows never receive production OIDC authority, signing material, or environment metadata.
- The public README will explain the production architecture, Azure services, security boundary, and generic self-hosting path without revealing deployed identifiers or operational details.
- Public generic Bicep must remain independently valid even when production composition and parameters are private.
