# Notification service

Azure Functions hosts installation-scoped Change Reminder registration and
throttle cleanup. This package also provides reusable APNs and FCM senders, and
keyless FCM access-token primitives. The APNs sender accepts an injected signed
provider token and HTTP/2 transport; it does not persist or log signing
material. No scheduled runtime currently composes or invokes them for Change
Reminder delivery; the owner-gated on-demand handler composes FCM or APNs only
when that provider's two gates are enabled. No Google service-account key or
long-lived FCM credential is accepted.

## Deployment settings

The deployed registration functions read the reminder settings below. The
owner-gated on-demand handler reads provider settings only after both of that
provider's gates are enabled.

| Setting                               | Purpose                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `REMINDER_MANAGED_IDENTITY_CLIENT_ID` | User-assigned Azure managed identity used by deployed registration and throttle-cleanup functions. |
| `REMINDER_STORAGE_ACCOUNT_NAME`       | Azure Table account used by deployed registration and throttle-cleanup functions.                  |
| `FCM_ENTRA_ASSERTION_AUDIENCE`        | Reserved Entra Application ID URI for the reusable keyless access-token provider.                  |
| `FCM_WORKLOAD_IDENTITY_PROVIDER`      | Reserved Google workload identity provider resource beginning `//iam.googleapis.com/projects/…`.   |
| `FCM_SERVICE_ACCOUNT_EMAIL`           | Reserved exact Google service account to impersonate for FCM.                                      |
| `FCM_PROJECT_ID`                      | Reserved exact Firebase/Google project for FCM HTTP v1 send URLs.                                  |
| `FCM_RUNTIME_ENABLED`                 | Enables the retained owner-controlled Android Change Reminder test composition.                    |
| `FCM_TEST_SEND_ENABLED`               | Existing default-disabled owner test-send gate shared by Android and iOS smoke sends.              |
| `APNS_RUNTIME_ENABLED`                | Enables the retained owner-controlled iOS Change Reminder test composition.                        |
| `APNS_ENVIRONMENT`                    | Required APNs host selection: exactly `sandbox` or `production`; no default is used.               |
| `APNS_TOPIC`                          | Required iOS bundle topic sent as the APNs topic header.                                           |
| `APNS_TEAM_ID`                        | Required ten-character Apple developer team ID for the provider JWT issuer.                        |
| `APNS_KEY_ID`                         | Required ten-character Apple signing key ID for the provider JWT header.                           |
| `APNS_PRIVATE_KEY`                    | Required PEM P-256 private key; it signs provider JWTs only in memory.                             |

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
until a private owner enables controlled testing for either provider. APNs
provider JWTs use ES256, cache only in memory for 50 minutes, and are never
logged or persisted. Deployment configuration remains private operations work.
