---
status: accepted
---

# Use low-infrastructure support channels

Daylight Saviour will use static help pages, public GitHub issue templates, private support email, and GitHub private vulnerability reporting instead of building an in-app support service.

## Consequences

- Public issue templates warn users not to submit personal information, credentials, or full push tokens.
- Personal, billing-store, or account-specific correspondence goes to a published support address rather than the public tracker.
- `SECURITY.md` defines supported versions and directs suspected vulnerabilities to private reporting rather than public issues.
- App settings expose links to help, privacy, source, issue reporting, private support, and security guidance.
- The ordinary copyable support diagnostic includes only app version, platform and OS version, Home Time Zone, pack and schema versions, freshness state, notification permission state, and reminder configuration.
- Ordinary support diagnostic output excludes installation identifiers and credentials, push tokens, precise hardware identifiers, logs, and environment details.
- A non-promotable FCM transport-proof build has one narrow, explicit local operator action after a successful matching registration. It may show only the opaque installation ID and matching Home Time Zone; those displayed registration values, and every credential or push token, are never transmitted or logged, and the build is absent from ordinary builds. This test artifact is not a support diagnostic.
- During physical-device diagnosis, an exact proof build may write only fixed enum stage markers to the local device log. They contain no payload, installation ID, Home Time Zone, token, credential, configuration, or other identifier; they are not transmitted or telemetry, and ordinary builds write none.
- Support pages, issue templates, and diagnostic redaction receive release tests like other user-facing behavior.
