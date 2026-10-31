# Notification service

Azure Functions hosts installation-scoped Change Reminder registration, daily
[retention cleanup](#stored-data-and-retention) and
[scheduled dispatch](#scheduled-dispatch), which stays suspended until an
operator enables it. This package also provides reusable APNs and FCM senders,
and keyless FCM access-token primitives. The APNs sender accepts an injected
signed provider token and HTTP/2 transport; it does not persist or log signing
material. The owner-gated on-demand handler composes FCM or APNs only when that
provider's two gates are enabled. No Google service-account key or long-lived
FCM credential is accepted.

The registration HTTP surface accepts a strictly validated `POST`, and the
installation-scoped `PUT` and `DELETE` endpoints require the current bearer
credential. Deletes physically remove subscription fields from the Table row
with an ETag check and retry concurrent mutations. The deleted subscription fields are replaced by a
credential-free retired-identity marker for 30 days so delayed registration
replays cannot recreate the identity; the marker is removed by the existing
operational cleanup timer. New registrations use versioned, time-bounded
request IDs, while active legacy rows remain recoverable during the rollout.
Well-formed missing or mismatched credentials return the same empty `204` as a
completed delete so idempotent retries do not reveal whether another
installation exists; malformed requests and storage failures remain coarse
errors. The mobile and service versions must be rolled out together: old
backends reject new versioned IDs and new backends do not create absent legacy
IDs.

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
records contain no push token or credential.

Provider acceptance does not establish arrival on a device. FCM TTL bounds
offline storage, while APNs explicitly treats expiry as best effort and allows
delivery delays. The dispatcher prevents stale send attempts; it cannot
guarantee when a device displays an accepted notification. See
[FCM message lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan)
and [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

The FCM sender requires an explicit message lifetime. A controlled smoke send
is `immediate` and sets a zero TTL, so FCM delivers it at once or drops it. A
queued send passes its expiry, and the sender sets the TTL from the whole
seconds left just before the request. It rejects an invalid expiry or one more
than FCM's four-week maximum away. If the expiry has passed by the time of the
request, it sends nothing and reports the send as expired. The APNs sender
takes the same lifetime: `immediate` sets `apns-expiration: 0`, and a queued
send sets the expiry in whole seconds, rounded down.

The FCM transport bounds each request, including its response body, to 10
seconds, and stops waiting even if `fetch` ignores the abort. A
request that fails or times out in transit is reported as uncertain, not as a
rejection, because FCM may still have accepted it.

The APNs transport has the same 10-second default bound, and the APNs sender
follows the same rule. A failed or invalid provider token stays a transient
rejection, because nothing was sent.

A scheduled send also passes a guard. After credentials are ready, each sender
calls the dispatcher's final authorization, then gives the transport only the
time left before the complete-operation deadline, within its 10-second bound.
If the deadline has passed, it sends nothing and reports the send as expired.

## Scheduled dispatch

The `reminder-dispatch` timer runs every five minutes. It sends only when
`REMINDER_DISPATCH_ENABLED` is exactly `true`. Any other value, or none, logs
`reminder-dispatch-suspended` and stops: nothing is read, sent or recorded, so
deploying the function cannot send anything. The audited kill switch is
[PUB-75](https://github.com/Binary-Balance/daylight-saviour/issues/75).

An enabled run:

1. Reads and verifies the signed manifest and pack, within 10 seconds. A failure
   stops planning for that run, and the next run retries. A pack promoted
   meanwhile applies from the next run.
2. Plans each pack zone at the run's start, and queries subscriptions only in
   zones with an open Delivery Window. Each query reads pages of up to 100 rows,
   at most 50 pages, with at most 8 dispatches in flight.
3. Dispatches each subscription's planned reminders. The provider expiry and
   complete-operation deadline are both the earliest of the Delivery Window end,
   Validity Horizon and Change Event.
4. Settles records no later plan will reach, up to 50 pages of 100: a pending or
   claimed record whose window has closed, and a rejected token whose cleanup is
   unfinished. This needs no pack and makes no provider send. A cleanup that
   keeps failing retries until the daily purge removes its record, 30 days after
   its last update.

Overlapping runs are safe: ledger claims admit one worker for each delivery, and
a send intent left by an interrupted run becomes uncertain and is not replayed.

The run logs one fixed `reminder-dispatch-<event> count=<n>` line for each event
that occurred, with no identifier, token, payload or provider detail:

| Event                           | Meaning                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `accepted`                      | The provider accepted a send.                                                                         |
| `uncertain`                     | The provider may have accepted a send. It is not repeated.                                            |
| `transient-failure`             | A send failed safely and retries in a later run, inside its window.                                   |
| `permanent-failure`             | The provider rejected a send for good.                                                                |
| `invalid-token-cleanup-failed`  | A rejected token is still stored. A later run retries without sending.                                |
| `expired`                       | **Eligible work was not delivered.** Alert on this event.                                             |
| `stale`                         | Registration or plan changed before the send, so nothing was sent.                                    |
| `claimed`, `pending`, `not-due` | Another worker holds the record, or there was nothing to do yet.                                      |
| `already-recorded`              | An earlier run recorded this delivery. It is not counted twice.                                       |
| `no-event`                      | No zone has an open Delivery Window.                                                                  |
| `pack-unavailable`              | **The pack could not be read or verified, so nothing was planned.**                                   |
| `pack-horizon-invalid`          | **The run's time is outside the active pack's coverage or Validity Horizon, so nothing was planned.** |
| `operation-failed`              | A storage call failed. The ledger keeps the delivery safe to retry.                                   |
| `page-limit-reached`            | **A query stopped at 50 pages, so later rows were not reached.**                                      |

Senders still write their own fixed events, such as
`fcm-credential-sts-denied`, to the same invocation log.

Storage requests measured with local stores and injected providers, for 250
subscriptions in one zone, 3 pages and 8 due zones:

| Work                     | First run: each send | Later runs: each subscription |
| ------------------------ | -------------------- | ----------------------------- |
| Ledger reads             | 9                    | 1                             |
| Ledger writes            | 4                    | 0                             |
| Subscription point reads | 3                    | 0                             |

Provider requests come from the code path, not a live measurement. Each FCM send
makes 1 FCM request, plus an STS and an impersonation request, because the
provider has no token cache, and asks for a managed-identity token, which the
Azure SDK may answer from its cache. Each APNs send opens 1 HTTP/2 session for 1
request. A run also makes 2 pack requests, and at most 8 sends are in flight, so
up to 24 FCM credential requests can run at once.

These counts do not yet justify token caching, connection pooling or new
infrastructure. Revisit them when a zone reaches thousands of subscriptions. At
5,000 in one zone a run reaches the page limit, and later rows are never reached
because each run starts at the first page. `page-limit-reached` is the signal to
add a durable cursor. The filter is on a non-key column, so Azure scans the
shared partition; a sparse zone can use extra pages, including empty ones, and
these count towards the limit.

Portable tests use injected stores, time and providers; they provide no
live-send or deployment evidence.

## Stored data and retention

| Record                                                 | Purpose                                                   | Contents                                                                                                                                                  | Kept until                                              |
| ------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Subscription (`ReminderSubscriptions`)                 | Send reminders and authorise changes to them              | Installation ID, credential hash, push token, platform, Home Time Zone, timing preferences, generation and registration time                              | Disable, deletion or a permanent invalid-token response |
| Retired-identity marker (`ReminderSubscriptions`)      | Stop a delayed registration recreating a removed identity | Installation ID, generation and retirement time                                                                                                           | 30 days after the subscription is removed               |
| Registration throttle (`ReminderRegistrationThrottle`) | Limit registration, update and deletion requests          | Hashed client IP address or installation ID, ten-minute window and request count                                                                          | 30 days after its window starts                         |
| Dispatch ledger (`ReminderDispatchLedger`)             | Send each reminder at most once and record its outcome    | Installation ID, Home Time Zone, Change Event, timing, generation, delivery window, pack horizon, status, claim, expiry and cleanup state, and timestamps | 30 days after its last update                           |

Uninstalling the app does not tell the service. An uninstalled app's
subscription stays until APNs or FCM rejects its token as permanently invalid,
which can only happen when something is sent to it. Apple does not promise
when, or whether, APNs starts rejecting a token after an uninstall, so such a
subscription may be kept indefinitely. When a reinstalled iOS app finds the
previous install's registration in the keychain, it makes one attempt to
delete that registration from the service before starting again.

Removing a subscription replaces its row with the marker at once. The daily
`reminder-throttle-cleanup` timer deletes the other expired rows, so a row can
outlive its limit by up to a day. Each run makes one pass over rows already
past their limit. Marker and ledger deletes carry the row's ETag, so a row that
changed is skipped; a row already gone is skipped too, so overlapping runs are
safe.

As a safeguard, the purge also keeps a ledger row until its Change Event has
passed, because a deleted row no longer stops that reminder being sent again.
Dispatch first writes a row when its delivery window opens, at most about
eight days before the event, so this does not arise in practice.

A storage error or function timeout ends the run, and the next day's run
continues. A malformed ledger row fails every run at that row, so later rows
wait until it is repaired.

## Deployment settings

The deployed registration functions read the reminder settings below. The
owner-gated on-demand handler reads provider settings only after both of that
provider's gates are enabled. Enabled scheduled dispatch needs all the FCM and
APNs provider settings and both pack settings; if any is missing it logs
`reminder-dispatch-unavailable` and sends nothing. It does not depend on the
test gates.

| Setting                               | Purpose                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `REMINDER_MANAGED_IDENTITY_CLIENT_ID` | User-assigned Azure managed identity used by deployed registration and throttle-cleanup functions. |
| `REMINDER_STORAGE_ACCOUNT_NAME`       | Azure Table account used by deployed registration and throttle-cleanup functions.                  |
| `FCM_ENTRA_ASSERTION_AUDIENCE`        | Reserved Entra Application ID URI for the reusable keyless access-token provider.                  |
| `FCM_WORKLOAD_IDENTITY_PROVIDER`      | Reserved Google workload identity provider resource beginning `//iam.googleapis.com/projects/…`.   |
| `FCM_SERVICE_ACCOUNT_EMAIL`           | Reserved exact Google service account to impersonate for FCM.                                      |
| `FCM_PROJECT_ID`                      | Reserved exact Firebase/Google project for FCM HTTP v1 send URLs.                                  |
| `REMINDER_DISPATCH_ENABLED`           | Enables scheduled dispatch when exactly `true`. Anything else suspends it.                         |
| `TIME_ZONE_DATA_MANIFEST_URL`         | Signed Time-Zone Data Pack manifest. Read only when dispatch is enabled.                           |
| `TIME_ZONE_DATA_TRUSTED_KEYS_JSON`    | JSON object of pack key IDs and Ed25519 public keys. Read only when dispatch is enabled.           |
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
hour. The reusable provider and senders produce fixed events for exchange
denials, transport failures, parsing, expiry, delivery, and failed invalid-token
cleanup. Tokens, assertions, provider bodies, and transport errors never enter
those events. The controlled handler writes them to the log of the Function
invocation that produced them, so an operator can tell a credential failure, a
provider rejection and a failed cleanup apart. A warm worker reuses the
composed runtime across overlapping invocations, so the logger finds the
current invocation through `AsyncLocalStorage` rather than keeping the first.
A logging failure never changes a send result.

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
