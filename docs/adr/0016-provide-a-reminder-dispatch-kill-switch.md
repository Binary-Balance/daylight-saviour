---
status: accepted
---

# Provide an audited reminder dispatch kill switch

Operators will be able to stop new Change Reminder dispatches independently of mobile releases and Time-Zone Data Pack publication. The switch will live in private Azure environment configuration managed through the operations repository and will default safely during invalid configuration.

## Consequences

- Disabling dispatch does not delete subscriptions, revoke installation credentials, or affect the app's local status experience.
- Timer executions record that dispatch is intentionally suspended and do not mark reminders as successfully sent.
- Switch activation and unexpected disabled state raise an Azure Monitor alert.
- Every change is authenticated, auditable, and restricted to the private operations path.
- Resuming dispatch requires explicit operator action after reviewing the original fault and current reminder eligibility.
- Expired Delivery Windows are never replayed after resumption.
- The switch controls reminder delivery only; Time-Zone Data Pack promotion retains its separate review gate.
