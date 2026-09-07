# Notification service

Azure Functions hosts installation-scoped Change Reminder registration and
throttle cleanup. This package also provides reusable APNs and FCM senders, and
keyless FCM access-token primitives. The APNs sender accepts an injected signed
provider token and HTTP/2 transport; it does not persist or log signing
material. No scheduled runtime currently composes or invokes them for Change
Reminder delivery; the owner-gated on-demand handler composes FCM or APNs only
when that provider's two gates are enabled. No Google service-account key or
long-lived FCM credential is accepted.

## Portable reminder dispatch

The [ledger](src/reminder-dispatch-ledger.ts) and
[dispatcher](src/reminder-dispatch.ts) consume planner facts and current
registration state through injected boundaries. Delivery identity is the
installation, canonical Home Time Zone, Change Event instant and reminder
timing. Token rotation, registration generation and pack updates do not create
a second delivery identity. Accepted and uncertain records stay closed when
registration changes.

Conditional creates and ETag updates give one worker a claim. Before calling
the provider, that worker saves its send intent. An abandoned claim without
send intent can be retried while eligible; an abandoned send intent becomes
uncertain and is never replayed automatically. A live worker may cancel its own
intent only before invoking the provider. Lost acknowledgements require
reconciliation against stored claim state, including when an Azure SDK retry
returns a conflict after a write committed. See
[Azure conditional updates](https://learn.microsoft.com/en-us/rest/api/storageservices/update-entity2).

Only a confirmed retryable failure permits another provider attempt. A thrown
provider error or unknown response is uncertain. This conservative policy can
miss a reminder after a crash between saving intent and sending; it does not
claim exactly-once provider delivery. Provider acceptance stays accepted even
when completion is recorded after the window. An eligible unsent reminder
expires rather than becoming overnight or post-event catch-up work.

Planner and ledger eligibility include exactly 09:00 and 21:00 in the Home
Time Zone and the pack's Validity Horizon. The Change Event instant itself is
ineligible. An operation deadline may stop an attempt sooner. The provider
contract carries explicit expiry and a complete-operation deadline, bounded by
the window, pack horizon and event. Final authorization must recheck current
registration, plan and time after credential acquisition, immediately before
the external send. Cancellation or a deadline alone cannot prove that a
provider rejected an attempted send.

Invalid-token cleanup has separate progress and retries without resending the
notification. It checks the rejected registration's generation and token, and
preserves registrations newer than an APNs invalidation timestamp. Ledger
records contain no push token or credential. Their `createdAt` and `updatedAt`
timestamps support the future 30-day retention task in
[PUB-74](https://github.com/Binary-Balance/daylight-saviour/issues/74).

Provider acceptance does not establish arrival on a device. FCM TTL bounds
offline storage, while APNs explicitly treats expiry as best effort and allows
delivery delays. The dispatcher prevents stale send attempts; it cannot
guarantee when a device displays an accepted notification. See
[FCM message lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan)
and [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

The current APNs and FCM senders do not implement this expiry, complete-operation
deadline and final-authorization contract. Production timer composition remains
in [PUB-73](https://github.com/Binary-Balance/daylight-saviour/issues/73), with
provider expiry in [PUB-133](https://github.com/Binary-Balance/daylight-saviour/issues/133),
safe invocation logging in [PUB-134](https://github.com/Binary-Balance/daylight-saviour/issues/134)
and network deadlines in [PUB-136](https://github.com/Binary-Balance/daylight-saviour/issues/136).
Provisioning the `ReminderDispatchLedger` table also remains pending. Portable
tests use injected stores, time and providers; they provide no live-send or
deployment evidence.

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

The function-key-protected controlled handler keeps failures coarse. Its sole
exception is HTTP 410 with the fixed `apns-unregistered-token-removed` outcome:
that means APNs classified the response as `410/Unregistered` and conditional
removal of that exact stored registration returned `removed`. It exposes no
provider response, token, credential, or other failure detail; every other
sender result remains the fixed unavailable outcome.
