---
status: accepted
---

# Use a minimal serverless Azure footprint

MVP Azure infrastructure will comprise one 512 MB Flex Consumption Function App with no always-ready instances, one Storage account for signed data packs and Table entities, one Key Vault for APNs private material and other secrets, Application Insights, managed identities, and least-privilege RBAC. FCM authorization uses keyless workload identity federation from the Azure runtime identity. HTTP functions manage installation-scoped subscriptions; a five-minute timer determines due zone/reminder combinations from the active data pack and dispatches directly through APNs and FCM.

## Consequences

- Subscriptions are partitioned by Home Time Zone so dispatch queries only due zone partitions.
- A dispatch ledger keyed by zone, Change Event, and reminder timing makes timer execution idempotent.
- Ledger state distinguishes pending, provider-accepted, permanently failed, and expired dispatches. The timer retries transient failures only during the reminder's 12-hour Delivery Window.
- Expired or permanently failed dispatches feed an Azure Monitor alert without storing or logging full push tokens.
- A scheduled retention task removes dispatch-ledger and operational entities older than 30 days and promptly removes subscriptions whose providers report permanently invalid tokens.
- No Cosmos DB, SQL, Service Bus, Durable Functions, API Management, Front Door, always-on compute, Kubernetes, or user identity service is introduced for MVP.
- Scaling or abuse evidence may justify adding infrastructure later, but speculative components are excluded.
