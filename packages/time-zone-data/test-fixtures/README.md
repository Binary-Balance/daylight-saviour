# Test-only signing material

`TEST-ONLY-ed25519-private.pem` is deterministic public fixture material. It
must never sign a candidate or production Time-Zone Data Pack. Real private
keys enter signing through an explicit file path and remain outside Git.

Fixture key ID: `test-only-2026-a`.

Raw Ed25519 public key, base64:
`A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`.

The recorded upstream refresh fixture contains the public IANA 2026c archive,
its detached signature, and Paul Eggert's public key:

- `tzdata2026c.tar.gz` SHA-256:
  `e4a178a4477f3d0ea77cc31828ff72aa38feff8d61aa13e7e99e142e9d902be4`
- archive source: <https://data.iana.org/time-zones/releases/tzdata2026c.tar.gz>
- detached signature: <https://data.iana.org/time-zones/releases/tzdata2026c.tar.gz.asc>
- release page: <https://www.iana.org/time-zones/releases/2026c>
- public-key retrieval by fingerprint: <https://keys.openpgp.org/vks/v1/by-fingerprint/7E3792A9D8ACF7D633BC1588ED97E90E62AA7E34>
- trusted primary fingerprint:
  `7E3792A9D8ACF7D633BC1588ED97E90E62AA7E34`

The archive and signature are public test evidence; the key is supplied
separately to exercise the explicit trust boundary. Production refreshes must
obtain and review their own current upstream key material.
