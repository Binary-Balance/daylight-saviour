---
status: accepted
---

# Expire silent reminder subscriptions after warning

Uninstalling the app sends the reminder service no signal, and Apple does not guarantee that APNs ever reports an uninstalled app's token as invalid. Without a limit, an uninstalled iOS app's subscription could be kept forever. The service will therefore record when each installation last contacted it, warn in Change Reminders after 12 months without contact, and delete the subscription after 24 months. This bounds retention of data the service no longer needs, while reminders stay set-and-forget: tapping one warned reminder keeps them.

## Considered options

- Keep subscriptions until a provider rejects the token: no limit on iOS.
- Confirm receipt from an iOS notification service extension, and delete after several unacknowledged reminders: needs native extension work, sends new delivery data to the service, and takes about a year to detect an uninstall.
- Send silent background pushes asking the app to check in: Apple throttles them and skips force-quit apps, so live installations would expire.
- Expire without warning: cancels set-and-forget users without telling them.

## Consequences

- Any authenticated request from the app counts as contact. The app also checks in when it comes to the foreground, at most once every 30 days, so opening it or tapping a reminder keeps the subscription.
- Daylight saving zones have a Change Event about every six months, so the 12 months between warning and deletion include two events, each with up to two warned Change Reminders.
- Subscriptions for Home Time Zones without a Change Event (ADR 0003) get no reminders, so they get no warning. They expire after 24 months without contact; their users lose nothing they would notice, and opening the app keeps them.
- Expiry stays disabled until scheduled dispatch can deliver the warning. Enabling it earlier would cancel users without notice.
- Expiry removes a subscription the same way disabling does, including the retired-identity marker. When an expired installation next contacts the service, the app shows Change Reminders as off, so the user can enable them again.
- The rule applies to both platforms. On Android, FCM usually rejects a stale token sooner: it expires registrations inactive for 270 days.
- This amends ADR 0006: inactivity cancels an enabled subscription only after warning and 24 months without contact.
