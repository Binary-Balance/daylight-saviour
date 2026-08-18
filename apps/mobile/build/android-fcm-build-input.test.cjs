const assert = require('node:assert/strict');
const { copyFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configureAndroidFcm } = require('./android-fcm-build-input.cjs');
const { createAppConfig } = require('../app.config.js');

const buildDirectory = path.dirname(
  require.resolve('./android-fcm-build-input.cjs'),
);
const fixture = (name) =>
  path.join(buildDirectory, '__fixtures__', `${name}.google-services.json`);

function externalFixture(t, name) {
  const directory = mkdtempSync(path.join(tmpdir(), 'daylight-saviour-fcm-'));
  const filePath = path.join(directory, 'google-services.json');
  copyFileSync(fixture(name), filePath);
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return filePath;
}

const baseAndroidConfig = {
  package: 'au.com.binarybalance.daylightsaviour',
};

test('configures Android FCM from an external Firebase file path', (t) => {
  const googleServicesFile = externalFixture(t, 'configured');

  assert.deepEqual(
    configureAndroidFcm(baseAndroidConfig, {
      DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: googleServicesFile,
    }),
    { ...baseAndroidConfig, googleServicesFile },
  );
});

test('rejects malformed Firebase configuration', (t) => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: externalFixture(
          t,
          'malformed',
        ),
      }),
    /Firebase client configuration must be valid JSON/,
  );
});

test('rejects Firebase configuration for a different Android package', (t) => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: externalFixture(
          t,
          'wrong-package',
        ),
      }),
    /Firebase client configuration does not contain Android package au\.com\.binarybalance\.daylightsaviour/,
  );
});

test('rejects a relative Firebase configuration path', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: 'google-services.json',
      }),
    /Firebase client configuration must be an absolute path outside the public checkout/,
  );
});

test('rejects a Firebase configuration path inside the public checkout', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: fixture('configured'),
      }),
    /Firebase client configuration must be an absolute path outside the public checkout/,
  );
});

test('leaves Android unconfigured when no Firebase input is supplied', () => {
  assert.deepEqual(
    configureAndroidFcm(baseAndroidConfig, {}),
    baseAndroidConfig,
  );
});

test('preserves unrelated app configuration', (t) => {
  const googleServicesFile = externalFixture(t, 'configured');
  const config = { android: baseAndroidConfig, extra: { retained: true } };

  assert.deepEqual(
    createAppConfig(config, {
      DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: googleServicesFile,
    }),
    {
      ...config,
      android: { ...baseAndroidConfig, googleServicesFile },
    },
  );
});
