# Notification service

Azure Functions hosts installation-scoped Change Reminder registration and
throttle cleanup. This package also provides reusable FCM sender and keyless
access-token primitives. No scheduled runtime currently composes or invokes
them for Change Reminder delivery; the owner-gated on-demand handler composes
them only when both FCM gates are enabled. No Google service-account key or
long-lived FCM credential is accepted.

## Deployment settings

The deployed registration functions read the reminder settings below. The
owner-gated on-demand handler reads the FCM settings only after both gates are
enabled.

| Setting                               | Purpose                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `REMINDER_MANAGED_IDENTITY_CLIENT_ID` | User-assigned Azure managed identity used by deployed registration and throttle-cleanup functions. |
| `REMINDER_STORAGE_ACCOUNT_NAME`       | Azure Table account used by deployed registration and throttle-cleanup functions.                  |
| `FCM_ENTRA_ASSERTION_AUDIENCE`        | Reserved Entra Application ID URI for the reusable keyless access-token provider.                  |
| `FCM_WORKLOAD_IDENTITY_PROVIDER`      | Reserved Google workload identity provider resource beginning `//iam.googleapis.com/projects/…`.   |
| `FCM_SERVICE_ACCOUNT_EMAIL`           | Reserved exact Google service account to impersonate for FCM.                                      |
| `FCM_PROJECT_ID`                      | Reserved exact Firebase/Google project for FCM HTTP v1 send URLs.                                  |
| `FCM_RUNTIME_ENABLED`                 | Enables the retained owner-controlled Change Reminder test composition.                            |
| `FCM_TEST_SEND_ENABLED`               | Explicit second gate for the function-key-protected owner-controlled test endpoint.                |

When composed, the keyless access-token provider accepts only short-lived
credentials: managed-identity assertions must have a valid future expiry, while
Google STS tokens and impersonated FCM access tokens are each bounded to one
hour. The reusable provider and sender produce fixed events for exchange
denials, transport failures, parsing, expiry, delivery, and failed invalid-token
cleanup. Tokens, assertions, provider bodies, and transport errors never enter
those events.

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

Generic Bicep defaults `fcm.enabled` to `false` and maps it to lowercase `true`
or `false` in `FCM_RUNTIME_ENABLED`. `FCM_TEST_SEND_ENABLED` remains `false`
until a private owner enables it for controlled testing. Generic Bicep also
temporarily retains the unused `FCM_PROOF_ENABLED=false` app setting to avoid
changing existing deployment lifecycle state; no runtime code reads it.
