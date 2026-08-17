---
status: accepted
---

# Minimise user data and client telemetry

Daylight Saviour will launch without accounts, advertising, behavioral analytics, cross-app tracking, or third-party client telemetry. Remote reminder infrastructure will retain only installation-scoped data required for delivery, expose deletion from the app, avoid logging complete push tokens, and use store-provided crash reporting plus server-side Application Insights for MVP operations.

## Consequences

- Product usage funnels and retention metrics will not be available initially.
- Privacy documentation must enumerate stored reminder data, purpose, retention, and deletion behavior.
- A permanent APNs or FCM unregistered-token response removes the corresponding subscription.
- Explicit reminder disable or in-app deletion promptly removes the server subscription; inactivity alone does not silently cancel an enabled service.
- Token-free dispatch-ledger and operational records are retained for 30 days, then purged automatically.
- Adding client analytics or diagnostics later requires a deliberate review of consent, disclosure, data minimisation, and this ADR.
- The non-promotable FCM transport-proof build is a deliberate, narrow exception for physical-device delivery evidence: after a successful matching registration, an explicit local operator action may display only an opaque installation ID and matching Home Time Zone. These displayed registration values, and every token or credential, are never transmitted or logged; this local display is not client telemetry, and the build is absent from ordinary builds and ordinary support diagnostics.
- During physical-device diagnosis, an exact proof build may write only fixed enum stage markers to the local device log. It never logs payload, installation ID, Home Time Zone, token, credential, configuration, or other identifiers; it is neither transmitted nor telemetry, and ordinary builds write none.
