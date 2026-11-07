# Reviewed expected diffs

A verified IANA release that changes Australian civil time is refused until a
person reviews the change. The review is a file here named
`<IANA version>.json`, for example `2027a.json`, and the refresh reads it
through `--expected-diff`. A tool that runs the refresh from a pinned commit
passes the file for the release it verified, so that commit carries the
reviews it accepts.

## Writing one

1. The refused refresh prints the semantic diff and a draft expected diff.
   Copy the draft unchanged into `<IANA version>.json`.
2. Write `explanation`: what changed and why, in plain words.
3. Fill each `evidence` entry with an HTTPS `url`, usually the IANA
   announcement or `NEWS` entry, and a `description`. `supports` lists the
   indexes of the `differences` that entry justifies; together the entries
   must cover every difference. Split the entry if sources differ.
4. Leave `sourceVersion`, `archiveSha256` and `differences` as printed. They
   bind the review to the exact archive and change.

A review is measured against the committed baseline pack. When the baseline is
regenerated onto that release, delete the file in the same change: it no
longer describes a difference and would fail conformance. A test enforces this.

Once a candidate has been published from a review, leave the file unchanged.
The review is recorded in the candidate's provenance, so an edit produces
different bytes for the same pack version.
