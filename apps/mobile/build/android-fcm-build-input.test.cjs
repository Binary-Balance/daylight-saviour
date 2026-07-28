const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { configureAndroidFcm } = require('./android-fcm-build-input.cjs');

const buildDirectory = path.dirname(
  require.resolve('./android-fcm-build-input.cjs'),
);
const fixture = (name) =>
  path.join(buildDirectory, '__fixtures__', `${name}.google-services.json`);

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

test('configures an FCM proof build from an external Firebase file path', () => {
  const googleServicesFile = fixture('configured');

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

test('rejects an FCM proof build without reviewed public runtime inputs', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: fixture('configured'),
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

test('rejects malformed Firebase configuration', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: fixture('malformed'),
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /Firebase client configuration must be valid JSON/,
  );
});

test('rejects Firebase configuration for a different Android package', () => {
  assert.throws(
    () =>
      configureAndroidFcm(baseAndroidConfig, {
        DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE: fixture('wrong-package'),
        DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD: '1',
      }),
    /Firebase client configuration does not contain Android package au\.com\.binarybalance\.daylightsaviour/,
  );
});

test('leaves ordinary builds unconfigured when no Firebase input is supplied', () => {
  assert.deepEqual(
    configureAndroidFcm(baseAndroidConfig, {}),
    baseAndroidConfig,
  );
});
