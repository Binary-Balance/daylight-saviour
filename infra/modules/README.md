# Generic Bicep modules

Reusable, environment-neutral Bicep modules belong here. Real environment compositions, parameters, identifiers, resource names, endpoints, and deployment evidence remain private.

## Minimal Functions platform

[`minimal-functions-platform.bicep`](minimal-functions-platform.bicep) is the only supported external seam for this platform. Its small interface hides identity, observability, storage, Key Vault, RBAC, Flex Consumption, app settings, and diagnostics orchestration under `internal/`. Callers must not reference internal modules directly.

Inputs:

- `location` — one Azure region for the platform.
- `resourceNames` — caller-approved names for Function App, plan, Storage, Key Vault, Log Analytics, Application Insights, runtime identity, and deployment container.
- `tags` — non-secret resource metadata.
- `runtime` — Node.js runtime name and supported version (`22` or `24`).
- `scale` — Flex Consumption memory (`512`, `2048`, or `4096` MB) and maximum scale-out (`1` through `1000`). No always-ready instances are created.
- `security` — Key Vault soft-delete and Log Analytics retention periods. Other security controls are fixed invariants.
- `buildVersion` — non-secret build identifier exposed by `/health`.

The module returns one `platform` object containing resource IDs, runtime identity identifiers, Function App host name, Key Vault URI, and deployment-container URI.

### Naming contract

Bicep validates current Azure minimum and maximum lengths and rejects unknown fields. Callers must also use valid Azure characters:

- Storage account: 3–24 lowercase letters or digits.
- Deployment container: 3–63 lowercase letters, digits, or single hyphens; start and end with alphanumeric.
- Function App: 2–60 alphanumeric characters or hyphens; start and end with alphanumeric.
- Key Vault: 3–24 alphanumeric characters or hyphens; start with a letter and end with alphanumeric.
- Log Analytics workspace: 4–63 alphanumeric characters or hyphens; start and end with alphanumeric.
- Function plan, Application Insights, and runtime identity use Azure limits enforced at the interface; this module recommends lowercase alphanumeric names with hyphens for consistent portable compositions.

Global names remain caller responsibility. Module never generates names or embeds environment identifiers.

### Security invariants

- One user-assigned managed identity handles Function host storage, package deployment storage, Key Vault secrets, and authenticated Application Insights publishing.
- Storage shared-key authorization, public blob access, cross-tenant replication, and insecure transport are disabled. Deployment container remains private.
- Runtime receives Storage Blob Data Owner, Storage Table Data Contributor, Key Vault Secrets User, and Monitoring Metrics Publisher. Queue access remains absent until a queue trigger or equivalent requirement exists.
- Key Vault uses Azure RBAC, soft delete, and purge protection; module provisions no secret values.
- Function App requires HTTPS/TLS 1.2, disables FTP and remote debugging, and denies FTP and SCM basic publishing credentials.
- Function App logs, Key Vault audit events, and supported platform metrics route to Log Analytics. Application Insights local authentication is disabled.

Public endpoints remain enabled for this minimal stack. Private networking requires a separate module or deliberate extension because it changes Flex Consumption routing and deployment-storage requirements.

References: [secure Flex Consumption Bicep quickstart](https://learn.microsoft.com/azure/azure-functions/functions-create-first-function-bicep), [Flex Consumption plan](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan), [identity-based host storage](https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity), and [Azure naming rules](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules).
