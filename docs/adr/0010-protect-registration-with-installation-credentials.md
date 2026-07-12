---
status: accepted
---

# Protect registration with installation credentials

MVP reminder registration will use server-issued, installation-scoped random credentials stored by the app in platform secure storage. No shared API key or user account is used; registration accepts only strictly validated fixed fields, while update and deletion require the installation credential.

## Consequences

- The service enforces request-size, field, zone, token-format, per-IP, and per-installation limits and monitors anomalous volume.
- Notification text is never client supplied.
- Push tokens remain private, encrypted by Azure Storage at rest, excluded from logs, and removed after permanent provider rejection.
- Apple App Attest, Google Play Integrity, API Management, and WAF infrastructure are deferred until observed abuse justifies their operational and open-source-development cost.
- Deleting a subscription invalidates its server-side installation credential. A later re-opt-in issues a fresh credential and stores it in platform secure storage.
