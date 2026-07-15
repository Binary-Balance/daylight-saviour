import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const host = JSON.parse(
  readFileSync(new URL('../host.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('notification-service artifact', () => {
  it('includes an Azure Functions v4 host manifest', () => {
    assert.equal(host.version, '2.0');
    assert.deepEqual(host.extensionBundle, {
      id: 'Microsoft.Azure.Functions.ExtensionBundle',
      version: '[4.0.0, 5.0.0)',
    });
    assert.deepEqual(host.extensions, {
      http: {
        routePrefix: '',
      },
    });
  });

  it('packages compiled functions and host metadata', () => {
    assert.equal(manifest.main, 'dist/index.js');
    assert.deepEqual(manifest.files, ['dist', 'host.json']);
  });
});
