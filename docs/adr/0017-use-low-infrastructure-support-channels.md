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
- A copyable diagnostic summary includes only app version, platform and OS version, Home Time Zone, pack and schema versions, freshness state, notification permission state, and reminder configuration.
- Diagnostic output excludes installation identifiers and credentials, push tokens, precise hardware identifiers, logs, and environment details.
- Support pages, issue templates, and diagnostic redaction receive release tests like other user-facing behavior.
