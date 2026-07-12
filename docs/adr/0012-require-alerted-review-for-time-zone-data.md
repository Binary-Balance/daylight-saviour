---
status: accepted
---

# Require alerted human review for time-zone data promotion

Verified IANA tzdb updates will not promote automatically to production. The private operations workflow will publish each Candidate Data Pack to non-production, open one assigned GitHub issue with its semantic diff and validation evidence, and require explicit manual promotion of the exact candidate version.

An Azure Monitor Action Group will email the operator when review becomes necessary, remind them after 24 hours, and escalate after 72 hours while production remains behind the verified candidate. Detection, verification, generation, or publication failures will raise a separate operational alert. Successful promotion will atomically update the production manifest, close the review issue, and resolve the stale-candidate alert.

## Consequences

- Political rule changes receive human scrutiny before affecting app answers or reminder scheduling.
- GitHub notifications are not the sole alert path; Azure provides independent email escalation.
- Reviews remain auditable through the issue, workflow run, candidate version, and production manifest.
- Promotion uses `workflow_dispatch` with the exact candidate version and explicit confirmation because required GitHub Environment reviewers for private repositories are unavailable without GitHub Enterprise.
- Only one review issue and one stateful alert exist per candidate, limiting duplicate notification noise.
- Alert delivery and resolution paths require deployment-time and periodic operational tests.
