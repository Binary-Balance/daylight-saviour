# Domain Glossary

Canonical Daylight Saviour domain terms follow. Use them consistently in code, documentation, and issues. This file defines language; it does not track implementation status or delivery progress. See [documentation index](docs/README.md) for reading order and [public GitHub issues](https://github.com/Binary-Balance/daylight-saviour/issues) for current work.

Daylight Saviour tells people whether daylight saving time currently applies and how clocks will move at the next change. It presents accurate Australian civil-time information with a polished, playful, anti-daylight-saving voice.

## Language

**Daylight Saving Status**:
Whether daylight saving time applies to a Home Time Zone at a particular instant.
_Avoid_: DST state, daylight savings status

**Home Time Zone**:
The user-selected civil-time region whose Daylight Saving Status and Change Events the app reports, even while the user travels elsewhere.
_Avoid_: Current location, device time zone, home location

**Friendly Zone Label**:
A reviewed geographic name presented to users for a canonical IANA zone, including regional scope where one jurisdiction contains multiple civil-time rules.
_Avoid_: Time-zone name, city alias, UTC label

**Australian Coverage**:
The complete set of Australian-administered civil-time regions represented by IANA, including external territories and regional exceptions.
_Avoid_: Mainland time zones, capital-city time zones

**Change Event**:
An upcoming civil-time offset transition caused by daylight saving rules.
_Avoid_: Time change, DST switch

**Forward Change**:
A Change Event that increases the UTC offset, causing local wall-clock time to skip forward.
_Avoid_: Spring forward

**Backward Change**:
A Change Event that decreases the UTC offset, causing local wall-clock time to repeat an interval.
_Avoid_: Fall back

**Change Reminder**:
A user-requested notification sent before the next Change Event for their Home Time Zone.
_Avoid_: Alert, DST notification, local notification

**Time-Zone Data Pack**:
A signed, versioned, IANA-derived dataset used by the app and notification service to determine Daylight Saving Status and Change Events independently of app releases.
_Avoid_: Time-zone database, rules file

**Candidate Data Pack**:
A verified Time-Zone Data Pack published to non-production and awaiting human review before production promotion.
_Avoid_: Latest data, pending database

**Validity Horizon**:
The final instant through which a Time-Zone Data Pack explicitly supports civil-time decisions. Passing it invalidates status, offset, event, and Countdown claims until a valid pack is installed.
_Avoid_: Expiry date, last checked date

**Delivery Window**:
The period from 9:00 am through 9:00 pm in the Home Time Zone during which a scheduled Change Reminder may be attempted or retried.
_Avoid_: Retry window, notification window

**Countdown**:
The absolute elapsed duration from now until a Change Event, calculated between UTC instants and displayed using its largest two useful units.
_Avoid_: Calendar countdown, wall-clock difference

**Living Dossier**:
Internal design term for the single structured home report whose hierarchy, reviewed copy, and semantic motion respond to genuine Change Event phases.
_Avoid in user-facing copy_: Dossier, dashboard mode, feed
