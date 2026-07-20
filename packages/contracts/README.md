# Contracts

`@daylight-saviour/contracts` owns runtime activation of portable data crossing
storage or network boundaries. Consumers must call `activateTimeZoneDataPack`
before using a Time-Zone Data Pack; TypeScript casts are not an activation
boundary.

Schema v2 accepts unique canonical IANA-style zones, including zones with no
Change Event in the Validity Horizon. Activation rejects unknown fields,
unsupported schema/source content, malformed instants, duplicate zones,
invalid offsets, incorrect bounds, and transition discontinuities. Activated
content is recursively frozen so downstream domain code receives immutable,
validated data. Product-specific coverage and reviewed labels belong in the
domain module, not this generic contract.

Signed-manifest v1 activation is equally strict. A manifest identifies one
immutable `packs/<packVersion>.pack.json` path, exact byte length and lowercase
SHA-256 digest, pack/schema versions, and an Ed25519 signature plus key ID.
`verifySignedTimeZoneDataPackBytes` accepts only manifests returned by
`activateSignedTimeZoneDataPackManifest`, verifies exact downloaded bytes with
strict RFC 8032 rules (`zip215: false`) against caller-supplied trusted public
keys, then activates JSON pack. Unknown keys, non-canonical base64, oversized
declarations, metadata mismatch, and malformed pack content fail closed.

Trusted keys are application build configuration. Manifests and downloaded
packs never add or replace trust anchors. Portable verification uses exact
`@noble/ed25519` 3.1.0 and `@noble/hashes` 2.2.0; signing remains Node-only.
