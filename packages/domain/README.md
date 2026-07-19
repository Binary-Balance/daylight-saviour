# Domain

`@daylight-saviour/domain` owns Australian Coverage catalogue, alias
normalization, pack coverage activation, and civil-time decisions.

Catalogue contains ten mainland/state regions and eight island/external
regions. Casey, Davis, and Mawson represent Australian Antarctic Territory
stations under the product definition of Australian-administered civil-time
regions. Uninhabited territories without IANA regions are excluded.

Aliases mirror tzdb 2026c `backward`; canonical region evidence comes from
`zone.tab`, `zone1970.tab`, `australasia`, `antarctica`, and `asia`. See pinned
archive provenance in `packages/time-zone-data`. Callers normalize device
identifiers with `normalizeAustralianZoneId`, persist only its canonical
result, and activate packs with `activateAustralianTimeZoneDataPack` before
calculation. Unsupported identifiers return `null`; offset similarity never
selects a zone.
