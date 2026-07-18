# Daylight Saviour Product Brief

_Status: accepted product direction. Portable delivery is tracked in [public GitHub issues](https://github.com/Binary-Balance/daylight-saviour/issues)._

## Purpose

Daylight Saviour gives a person an immediate, accurate answer to whether daylight saving time currently applies in their Home Time Zone and what will happen at the next Change Event. It treats civil-time complexity with polished, ironic humour informed by the creator's dislike of daylight saving and its disruption to body clocks.

## Launch Scope

- Native Android and iOS app distributed through Australian stores.
- Expo web is a development and automated-test surface, not a launch product.
- Complete Australian Coverage, including external territories and regional exceptions.
- Saved Home Time Zone, initially suggested from the device's IANA time zone; no location permission.
- International zone selection deferred, while time-zone engine remains globally capable.
- Latest stable Expo SDK at implementation time, using its default minimum Android and iOS versions without custom legacy support.
- Australian English is the only launch language. User-facing strings and copy catalogues remain externalized so later localization does not require separating prose from components.

## Core Experience

MVP is a glanceable, single-screen experience with no tab navigation. It shows:

1. Daylight Saving Status.
2. Friendly Home Time Zone label.
3. Next Change Event date and local time, direction, and offset amount.
4. Countdown to that event.
5. Change Reminder state and timing.
6. Discreet time-zone data freshness.
7. Access to compact settings.

Zones with no upcoming Change Event receive an equally intentional, celebratory state rather than an empty result.

These zones may still enable Change Reminders. Their subscription remains dormant while no event is scheduled and becomes eligible if a later verified Time-Zone Data Pack introduces one. Reminder timings already past when a new rule appears are not sent as catch-up notifications.

Countdowns measure absolute elapsed time between UTC instants, never subtraction between local wall-clock fields. They show the largest two useful units, including the hour removed or repeated by a Change Event; the exact local event date and time remain visible beside them.

The single screen behaves as a Living Dossier rather than a static annual lookup. This internal design term means one structured report whose hierarchy, reviewed copy, and one-shot semantic motion respond to genuine civil-time state; it is not user-facing language, a feed, or a collection of screens.

Phases are deterministic: Ordinary more than 28 days before an event; Approaching from 28 days through 7 days; Reminder Week from 7 days through 24 hours; Reminder Day during the final 24 hours; atomic status replacement at the event instant; Aftermath on the first opening within 48 hours; then New Event. A Change Event is instantaneous, so no persistent “underway” state exists. No artificial milestone, unread state, or invented urgency is added.

## Onboarding

First launch suggests an Australian Home Time Zone from the device's IANA time zone, then asks the user to confirm or choose manually. No location permission is requested. The app shows a functional home screen before presenting the contextual reminder action, “Warn me before time misbehaves.” OS notification permission is requested only after the user chooses to enable reminders; denial does not reduce core app functionality.

Zone selection presents reviewed human geography first and a canonical IANA identifier as secondary metadata. Mainland/state regions are grouped separately from islands and external territories. Device-reported aliases normalize to canonical supported zones; current UTC offset never determines grouping because it changes across Change Events.

The reminder action first explains that one-week and one-day reminders will be enabled, with both timings selected by default. Only explicit confirmation opens the OS permission prompt. Either timing remains independently configurable; disabling both deletes the server subscription. Opt-out is reversible: enabling either timing again creates a fresh registration, requesting OS permission when available or directing the user to system settings when permission is blocked there.

## Voice & Presentation

Copy is playful, ironic, and openly sceptical of daylight saving without sacrificing factual clarity. Presentation must feel deliberate and premium, not like a novelty demo.

Every message presents the fact first and a dry joke second. Humour targets civil-time machinery and bureaucracy, never users or communities. Shipped copy and store metadata avoid profanity, unsupported health claims, and jokes inside literal accessibility labels or user-caused error states.

Stable factual copy is paired with a large, reviewed catalogue of secondary lines. Eligible variants respond to status, Change Event direction, proximity, and respectful regional context. Selection remains stable within a day or event, avoids recent repetition, and uses a stricter catalogue for notifications. Time-zone logic never depends on copy selection.

Ordinary secondary copy selects deterministically per Home Time Zone and local day. It may reward an incidental return with a fresh line but never advertises daily content or asks the user to return tomorrow. Event-specific copy may remain stable across a meaningful event phase where repetition improves clarity.

Initial catalogue targets roughly 150–200 reviewed lines: at least 30 home-screen variants for each broad status, proximity-specific additions, regional supplements, and at least 12 notification variants for each timing/direction combination. Selection targets 30 days without repetition per Home Time Zone. Copy is source-controlled and may be agent-drafted, but no runtime AI generates user-facing text.

Motion is a first-class part of the experience. Directional transitions, kinetic typography, clock movement, countdown changes, and small responsive touches should make the simple information enjoyable to revisit. Motion must reinforce meaning, remain performant, and respect reduced-motion accessibility settings.

The clock, typography, copy, and motion carry the app's personality without an explicit mascot. Forward Changes accelerate and skip; Backward Changes reverse and echo; zones without a Change Event settle into deliberate stillness.

Visual direction is polished bureaucratic modernism: oversized editorial time, a crisp grid, restrained official-document motifs, dry status stamps, warm daylight cream, midnight navy, and one sharp warning accent. Motion may distort the grid and typography around Forward and Backward Changes. Cartoon clocks, generic gradient-led styling, and obvious Australian clichés are excluded.

The app provides polished light and dark themes that follow the operating system appearance setting. MVP does not need an independent in-app theme override. Status and direction remain understandable without relying on colour alone.

## Accessibility & Quality

Accessibility is a launch requirement, not a later enhancement. Core flows must work with VoiceOver and TalkBack, operating-system text scaling, increased contrast, and reduced-motion preferences. Information cannot depend on colour, animation, or humour; accessibility labels state facts literally. Controls require generous touch targets and logical focus order.

Release checks combine automated accessibility assertions with manual smoke testing on physical or representative Android and iOS devices. Store submission is blocked by critical failures in screen-reader navigation, text scaling, contrast, reduced-motion behavior, or core task completion.

Civil-time correctness is also release-blocking. A shared deterministic conformance suite covers every supported Australian zone, transition boundaries, non-hour changes, regions without daylight saving, external territories, stale-data states, and agreement between app and notification service. Any unexplained transition difference blocks app release or Time-Zone Data Pack promotion.

Dates use explicit Australian day-month ordering and unambiguous month names where space permits. Times follow the device's 12-hour or 24-hour preference and always describe the Home Time Zone, regardless of the device's current location. Time-zone identifiers, instants, offsets, and calculations remain independent of presentation locale.

## Reminders & Freshness

Change Reminders are sent remotely through direct APNs and FCM delivery from lightweight Azure infrastructure. Current transition data comes from remotely distributed IANA-derived Time-Zone Data Packs, so political rule changes do not require an app-store release.

When reminders are enabled, MVP offers two independently configurable sends per Change Event: one week before and one day before, both at 9:00 am in the Home Time Zone. It never sends at the overnight transition itself. Reminder timing continues to follow Home Time Zone while the user travels.

Each reminder has a 12-hour Delivery Window, from 9:00 am through 9:00 pm in the Home Time Zone. Transient failures are retried idempotently within that window. An unsent reminder expires at 9:00 pm, is never delivered overnight or after its Change Event, and raises an operational alert. APNs and FCM delivery remains best-effort, so user-facing copy does not promise arrival.

For a Home Time Zone without a scheduled event, reminder UI states: “No change scheduled. Keep reminders on and we’ll warn you if that changes.” Enabling it registers the same independently configurable one-week and one-day preferences without generating any immediate notification.

The app bundles a known-good Time-Zone Data Pack and caches newer verified packs for offline use. Packs declare their source version, generation time, and validity horizon. Download or validation failures retain the last known-good pack. Once data no longer covers the current decision, the app shows an explicit refresh-required state and never presents missing transition data as proof that no change exists.

After the active pack's validity horizon passes, the app fails closed for civil-time claims. It retains Home Time Zone name, reminder configuration, last verified pack details, and retry controls, but suppresses Home Time Zone clock, Daylight Saving Status, offset, next event, and Countdown until valid data is restored. Refresh-required language is factual and contains no joke.

The app checks the signed pack manifest on cold launch and when returning to the foreground if at least 24 hours have passed since its last check. Conditional HTTP requests avoid downloading unchanged data. Freshness details provide a manual retry. Correctness does not depend on mobile background execution: the remote reminder service updates independently, while a closed app continues using its known-good pack when next opened.

IANA updates are detected daily. Automation verifies the upstream signature, generates a deterministic Candidate Data Pack, runs transition and regression tests, and publishes it to non-production. Production promotion always requires human review.

Review requests must be difficult to miss without becoming noisy. The private operations workflow opens one assigned GitHub issue per candidate containing the rule diff, affected zones, test evidence, non-production location, and exact promotion action. An Azure Monitor Action Group sends an immediate email, repeats after 24 hours, and escalates after 72 hours while production remains behind the verified candidate. Detection or generation failures raise a separate operational alert. Promotion uses a manually dispatched workflow requiring the exact candidate version and explicit confirmation; successful promotion closes the issue and resolves the alert.

## Privacy

MVP has no accounts, advertising, behavioral analytics, cross-app tracking, or third-party client telemetry. It stores only an installation identifier, push token, Home Time Zone, reminder preferences, and service timestamps needed to deliver Change Reminders. The app can delete its reminder subscription and associated server data. Server logs must not contain full push tokens.

An enabled reminder subscription remains active without arbitrary inactivity expiry: reminders are intentionally set-and-forget. Explicit disable or deletion, and permanent invalid-token responses from APNs or FCM, remove the server record promptly. Token-free dispatch-ledger and operational records expire after 30 days. Retention behavior is stated plainly in the privacy policy.

Each installation receives an opaque credential for updating or deleting only its own reminder subscription. No shared secret is embedded in the app. Registration accepts only fixed, validated reminder fields and never arbitrary notification content; platform attestation is deferred unless observed abuse justifies it.

Operational telemetry stays in Azure Application Insights; client crashes are observed through App Store Connect and Google Play reporting. Any later client diagnostics require an explicit product and privacy decision.

## Explicitly Deferred

- Multiple saved time zones or comparison views.
- Maps, historical timelines, articles, accounts, and social features.
- International location selection.
- Daylight-saving advocacy or health-content sections.
- iOS and Android home/lock-screen widgets and their remote-refresh infrastructure.
- Compact event explainers, calendar export, and locally generated shareable status cards.
- Full public web application; launch web presence is limited to product, privacy, support, store, and source information.

Daily promotional notifications, streaks, badges, points, fake countdown milestones, engagement feeds, runtime AI copy, and hidden information designed to force reopening are explicitly excluded.

## Commercial Model

Launch is free and unmonetised: no ads, subscriptions, in-app purchases, donation prompts, or paid reminder features. Operating and store-account costs are absorbed during validation; any later monetisation requires a new product decision.

## Release & Operations

Release candidates pass through TestFlight and Google Play closed testing before Australian production availability. Beta checks include supported-device smoke tests, accessibility, transition boundaries, registration, both reminder timings, notification taps, data refresh, and deletion. Production availability expands only while crash, registration, dispatch-expiry, and freshness signals remain healthy.

Operations include a private, audited reminder kill switch. Activating it stops new APNs and FCM sends without deleting subscriptions, changing Time-Zone Data Packs, or degrading the app's offline status experience. Activation raises an operator alert; resumption requires explicit review after the fault is understood.

## Open Source

Public product code, generic infrastructure modules, tests, and technical documentation use Apache-2.0. The Daylight Saviour name, app icon, store artwork, and distinctive product identity remain reserved and are not granted for confusing or impersonating distributions.

The public repository also publishes a minimal GitHub Pages site containing product information, privacy policy, support details, time-zone data methodology, source and attribution links, and store links. Expo web itself is not deployed as the launch product.

## Support & Reporting

MVP has no custom support backend. App and website link to public help content and structured GitHub issue templates for ordinary defects and feature requests. A private support email receives reports involving personal information or store-user account problems. Security reports use GitHub private vulnerability reporting and the process documented in `SECURITY.md`.

Users can copy a small diagnostic summary containing app version, platform and OS version, selected Home Time Zone, Time-Zone Data Pack and schema versions, freshness state, notification permission state, and reminder configuration. It excludes push tokens, installation identifiers and credentials, precise device details, and server-side secrets.
