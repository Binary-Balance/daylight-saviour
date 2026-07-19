import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { generateSydneyPackBytes } from '../scripts/generate-sydney-pack.mjs';

const generatedPackUrl = new URL(
  '../generated/australia-sydney.pack.json',
  import.meta.url,
);

describe('Sydney Time-Zone Data Pack generator', () => {
  it('produces byte-identical output for identical pinned input', async () => {
    const first = await generateSydneyPackBytes();
    const second = await generateSydneyPackBytes();

    assert.equal(first, second);
  });

  it('matches the reviewed bundled pack byte for byte', async () => {
    const generated = await generateSydneyPackBytes();
    const bundled = await readFile(generatedPackUrl, 'utf8');

    assert.equal(generated, bundled);
  });
});
