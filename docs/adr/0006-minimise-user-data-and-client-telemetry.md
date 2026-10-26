---
status: accepted
---

# Minimise user data and client telemetry

Daylight Saviour will launch without accounts, advertising, behavioral analytics, cross-app tracking, or third-party client telemetry. Remote reminder infrastructure will retain only the data needed to deliver reminders and limit abuse (ADR 0010), expose deletion from the app, avoid logging complete push tokens, and use store-provided crash reporting plus server-side Application Insights for MVP operations.

## Consequences

- Product usage funnels and retention metrics will not be available initially.
- Privacy documentation must enumerate stored reminder data, purpose, retention, and deletion behavior.
- A permanent APNs or FCM unregistered-token response removes the corresponding subscription. Providers do not guarantee that response after an uninstall, so an uninstalled app's subscription may be kept indefinitely.
- Explicit reminder disable or in-app deletion promptly removes the server subscription data; a credential-free retired-identity marker is kept for 30 days to fence delayed registration replays. Inactivity cancels an enabled service only after warning and 24 months without contact (ADR 0022).
- Token-free dispatch-ledger and other operational Table records are retained for 30 days, then purged automatically.
- Adding client analytics or diagnostics later requires a deliberate review of consent, disclosure, data minimisation, and this ADR.
