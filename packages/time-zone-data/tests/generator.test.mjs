import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { generateAustralianPackBytes } from '../scripts/generate-australian-pack.mjs';

const generatedPackUrl = new URL(
  '../generated/australian-coverage.pack.json',
  import.meta.url,
);

describe('Australian Coverage Time-Zone Data Pack generator', () => {
  it('produces byte-identical output for identical pinned input', async () => {
    const first = await generateAustralianPackBytes();
    const second = await generateAustralianPackBytes();

    assert.equal(first, second);
  });

  it('matches the reviewed bundled pack byte for byte', async () => {
    const generated = await generateAustralianPackBytes();
    const bundled = await readFile(generatedPackUrl, 'utf8');

    assert.equal(generated, bundled);
  });
});
