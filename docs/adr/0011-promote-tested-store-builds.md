---
status: accepted
---

# Promote tested store builds without rebuilding

Mobile releases begin from immutable semantic-version tags in the public repository. A private operations workflow checks out the exact tag, builds signed Android and iOS artifacts once, submits them to Google Play internal testing and TestFlight, then promotes those same artifacts to production after documented manual approval and device smoke tests.

## Consequences

- Release provenance records source commit, lockfile hash, versions, and artifact identities.
- Tags are never mutated; fixes create a new patch release.
- Store metadata and non-sensitive screenshots may remain versioned publicly, while credentials and release logs remain private.
- Platform submission failures can be handled independently, but corresponding release state must remain documented.
- Release candidates must pass TestFlight and Google Play closed-testing smoke checks before Australian production rollout begins.
- Production availability expands only while crash, registration, dispatch-expiry, and data-freshness signals remain within documented operational thresholds.
