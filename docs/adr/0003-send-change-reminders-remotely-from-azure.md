---
status: accepted
---

# Send Change Reminders remotely from Azure

Daylight Saviour will send Change Reminders from lightweight Azure-hosted infrastructure rather than scheduling them only on each device. The service will use current Time-Zone Data Pack data when dispatching reminders, allowing changed daylight-saving rules to take effect without an app launch or app-store release. Azure will deliver directly through APNs and FCM rather than through Expo Push Service.

## Consequences

- MVP infrastructure must register and retire device push tokens, retain each installation's Home Time Zone and reminder preference, schedule sends, and process delivery failures.
- Registration will be installation-scoped; user accounts are not required for MVP.
- Stored data and Azure permissions must be minimal, and push tokens must be treated as sensitive identifiers.
- APNs and FCM provider credentials must be isolated in Azure Key Vault and accessed only by the sender's managed identity.
- The app will not schedule equivalent long-lived local reminders, avoiding duplicate or stale notifications.
- Delivery remains best-effort because APNs and FCM do not guarantee arrival.
- Each reminder is eligible from 9:00 am through 9:00 pm in the Home Time Zone. Transient failures are retried idempotently only within that Delivery Window.
- An unsent reminder expires after its Delivery Window and is never delivered overnight or after its Change Event. Expiry raises an operational alert rather than causing a stale push.
- Enabled subscriptions do not expire merely because the app has not opened; reminder delivery is a set-and-forget service.
- Explicit user disable or deletion and permanent APNs or FCM invalid-token responses promptly delete the subscription.
- Initial opt-in explains both reminder timings before requesting OS permission; one-week and one-day reminders default on after explicit confirmation.
- Users can disable either timing independently. Disabling both deletes the remote subscription, while later re-enabling either timing creates a fresh registration.
- If OS notification permission remains available, re-opt-in completes in-app. If permission is blocked at OS level, the app explains the state and links to system settings rather than claiming reminders are active.
- Home Time Zones with no scheduled Change Event may retain a dormant subscription so later verified rules can activate ordinary one-week or one-day reminders.
- A newly introduced event never causes catch-up delivery for a reminder timing whose Delivery Window has already passed.
