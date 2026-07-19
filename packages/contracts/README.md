# Contracts

`@daylight-saviour/contracts` owns runtime activation of portable data crossing
storage or network boundaries. Consumers must call `activateTimeZoneDataPack`
before using a Time-Zone Data Pack; TypeScript casts are not an activation
boundary.

Schema v1 currently accepts one reviewed `Australia/Sydney` slice. Activation
rejects unknown fields, unsupported schema/source content, malformed instants,
invalid offsets, incorrect bounds, and transition discontinuities. Activated
content is recursively frozen so downstream domain code receives immutable,
validated data.
