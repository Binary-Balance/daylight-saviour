---
status: accepted
---

# Present reviewed geographic labels for time zones

Zone selection will lead with reviewed human geography and show canonical IANA identifiers only as secondary disambiguation. Device-reported aliases will normalize to canonical supported zones before persistence and domain calculation.

## Consequences

- Labels describe actual regional scope, such as “Sydney, Canberra & most of NSW” and “Broken Hill & far-western NSW,” rather than presenting one representative city as the whole zone.
- Mainland and state regions form one chooser group; islands and external territories form another.
- Regional exceptions and external territories remain explicit choices rather than being collapsed into nearby offsets.
- Current UTC offset does not control naming or grouping because offsets change over time.
- A source-controlled mapping owns canonical IDs, accepted aliases, friendly labels, search terms, and grouping.
- Mapping review and tests cover every zone in Australian Coverage, every accepted device alias, duplicate search terms, and unsupported-zone fallback.
- International expansion requires a separately reviewed naming catalogue rather than automatically exposing raw IANA identifiers.
