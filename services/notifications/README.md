# Notification service

Azure Functions hosts installation-scoped Change Reminder registration and
provider delivery. FCM delivery uses Azure managed identity, Google Workload
Identity Federation, and exact service-account impersonation. No Google
service-account key or long-lived FCM credential is accepted.

## FCM runtime settings

Portable composition reads these environment settings:

| Setting                               | Purpose                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `REMINDER_MANAGED_IDENTITY_CLIENT_ID` | User-assigned Azure managed identity used for Entra and Table authorization.                                               |
| `REMINDER_STORAGE_ACCOUNT_NAME`       | Azure Table account containing reminder registrations.                                                                     |
| `FCM_ENTRA_ASSERTION_AUDIENCE`        | Microsoft Entra Application ID URI configured as Google provider allowed audience. Runtime requests its `/.default` scope. |
| `FCM_WORKLOAD_IDENTITY_PROVIDER`      | Full Google workload identity provider resource beginning `//iam.googleapis.com/projects/…`.                               |
| `FCM_SERVICE_ACCOUNT_EMAIL`           | Exact Google service account impersonated for FCM.                                                                         |
| `FCM_PROJECT_ID`                      | Exact Firebase/Google project used in FCM HTTP v1 send URLs.                                                               |
| `FCM_RUNTIME_ENABLED`                 | Must be exactly `true` before FCM runtime or proof composition is available.                                               |

Runtime accepts only short-lived credentials: managed-identity assertions,
Google STS tokens, and impersonated FCM access tokens are each bounded to one
hour. Exchange denials, transport failures, parsing, expiry, delivery, and
failed invalid-token cleanup produce distinct fixed event names. Tokens,
assertions, provider bodies, and transport errors never enter those events.

## Least privilege

Private environment composition must:

- restrict Entra application assignment to runtime managed identity and match
  `FCM_ENTRA_ASSERTION_AUDIENCE` to Google provider allowed audience;
- restrict workload identity provider attributes to expected Azure tenant and
  managed-identity subject;
- grant federated principal service-account impersonation only on exact
  `FCM_SERVICE_ACCOUNT_EMAIL`;
- grant that service account only FCM message-send permission in exact
  `FCM_PROJECT_ID` (a custom role containing
  `cloudmessaging.messages.create` is narrowest; predefined
  `roles/firebasecloudmessaging.admin` is broader);
- grant Azure runtime identity only Storage Table Data Contributor for
  registration cleanup and omit Google keys from Key Vault and app settings.

References:
[Google Azure workload federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds),
[service-account impersonation roles](https://cloud.google.com/iam/docs/service-account-permissions),
and [FCM IAM permissions](https://cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging).

## Controlled FCM proof

`POST /internal/fcm-proof` is a deployment proof, not a product endpoint. It is
disabled unless both `FCM_RUNTIME_ENABLED` and `FCM_PROOF_ENABLED` are exactly
`true`, and requires Azure Functions `function` authorization after deployment.
Local Functions execution does not enforce access keys.

Proof inputs are environment-owned:

| Setting                      | Accepted value                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `FCM_PROOF_INSTALLATION_ID`  | Existing installation ID resolving to stored Android registration. |
| `FCM_PROOF_HOME_TIME_ZONE`   | Canonical supported Australian Home Time Zone.                     |
| `FCM_PROOF_CHANGE_EVENT_AT`  | Exact ISO-8601 UTC instant.                                        |
| `FCM_PROOF_CHANGE_DIRECTION` | `forward` or `backward`.                                           |
| `FCM_PROOF_TIMING`           | `one-week` or `one-day`.                                           |

Request body is ignored. Caller cannot supply device token, project, service
account, payload, or copy. Runtime resolves existing registration and builds
reviewed fixed Change Reminder payload.

Before enabling proof, private operations must add stronger ingress
authorization such as private access or identity-aware proxy, keep function key
in approved secret storage, set fixed proof values, and record reviewed evidence.
Disable proof immediately afterward. Generic Bicep defaults `fcm.enabled` to
`false`, maps it to `FCM_RUNTIME_ENABLED`, and always forces
`FCM_PROOF_ENABLED=false`. Environment-specific runtime enablement, proof
override, and evidence remain private.
