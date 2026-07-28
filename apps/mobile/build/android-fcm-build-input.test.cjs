const assert = require('node:assert/strict');
const { copyFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configureAndroidFcm } = require('./android-fcm-build-input.cjs');

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

const proofRuntimeInputs = {
  EXPO_PUBLIC_REMINDER_REGISTRATION_URL:
    'https://reminders.example.invalid/registrations',
  EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL:
    'https://time-zone-data.example.invalid/manifest.json',
  EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON:
    '{"synthetic-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
};

test('configures an FCM proof build from an external Firebase file path', (t) => {
  const googleServicesFile = externalFixture(t, 'configured');

  assert.deepEqual(
    configureAndroidFcm(baseAndroidConfig, {
      ...proofRuntimeInputs,
      DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: googleServicesFile,
      DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
    }),
    {
      ...baseAndroidConfig,
      googleServicesFile,
    },
  );
});

test('rejects an FCM proof build without reviewed public runtime inputs', (t) => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: externalFixture(
          t,
          'configured',
        ),
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /FCM proof build requires EXPO_PUBLIC_REMINDER_REGISTRATION_URL, EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL, EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON/,
  );
});

test('rejects an FCM proof build without Firebase configuration', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /FCM proof build requires DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE/,
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
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
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
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /Firebase client configuration does not contain Android package au\.com\.binarybalance\.daylightsaviour/,
  );
});

test('rejects a relative Firebase configuration path', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: 'google-services.json',
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /Firebase client configuration must be an absolute path outside the public checkout/,
  );
});

test('rejects a Firebase configuration path inside the public checkout', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: fixture('configured'),
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /Firebase client configuration must be an absolute path outside the public checkout/,
  );
});

test('leaves ordinary builds unconfigured when no Firebase input is supplied', () => {
  assert.deepEqual(
    configureAndroidFcm(baseAndroidConfig, {}),
    baseAndroidConfig,
  );
});
