import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { health, healthOptions } from './health.js';

const originalBuildVersion = process.env.BUILD_VERSION;

afterEach(() => {
  if (originalBuildVersion === undefined) {
    delete process.env.BUILD_VERSION;
  } else {
    process.env.BUILD_VERSION = originalBuildVersion;
  }
});

describe('health', () => {
  it('registers one anonymous GET route', () => {
    assert.equal(healthOptions.authLevel, 'anonymous');
    assert.deepEqual(healthOptions.methods, ['GET']);
    assert.equal(healthOptions.route, 'health');
    assert.equal(healthOptions.handler, health);
  });

  it('returns only status and build version', () => {
    process.env.BUILD_VERSION = 'build-123';

    const response = health();

    assert.equal(response.status, 200);
    assert.deepEqual(response.jsonBody, {
      status: 'ok',
      version: 'build-123',
    });
    assert.deepEqual(Object.keys(response.jsonBody as object).sort(), [
      'status',
      'version',
    ]);
  });

  it('does not cache health responses or expose an empty version', () => {
    process.env.BUILD_VERSION = '   ';

    const response = health();

    assert.deepEqual(response.headers, {
      'Cache-Control': 'no-store',
    });
    assert.deepEqual(response.jsonBody, {
      status: 'ok',
      version: 'unavailable',
    });
  });
});
