---
status: accepted
---

# Calculate countdowns between instants

Countdowns to Change Events will measure absolute elapsed duration between the current UTC instant and event UTC instant. They will never subtract Home Time Zone wall-clock fields, which become discontinuous during Forward and Backward Changes.

## Consequences

- A removed or repeated hour remains visible in countdown mathematics rather than being silently normalized as a 24-hour local day.
- Presentation uses the largest two useful units and updates only when a displayed unit changes.
- Exact Home Time Zone event date and local-time transformation remain adjacent, preventing countdown units from carrying the full explanation.
- Shared domain code produces countdown values for mobile presentation and deterministic boundary tests.
- Tests cover Forward Changes, Backward Changes, Lord Howe's 30-minute change, repeated local times, skipped local times, and the instant at which the event becomes past.
- Screen readers receive a stable duration phrase and are not notified on every visual countdown update.
