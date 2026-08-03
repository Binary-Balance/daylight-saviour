const { readFileSync, realpathSync } = require('node:fs');
const { dirname, isAbsolute, relative, sep } = require('node:path');

const {
  parseReminderRegistrationEndpoint,
  parseTimeZoneDataPackRemoteConfig,
} = require('../src/public-runtime-configuration.cjs');

const ANDROID_PACKAGE = 'au.com.binarybalance.daylightsaviour';
const GOOGLE_SERVICES_FILE_ENV =
  'DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE';
const FCM_PROOF_BUILD_ENV = 'DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD';
const REMINDER_REGISTRATION_URL_ENV = 'EXPO_PUBLIC_REMINDER_REGISTRATION_URL';
const REMOTE_TIME_ZONE_DATA_INPUTS = [
  'EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL',
  'EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON',
];
const PUBLIC_SOURCE_ROOT = dirname(require.resolve('../../../package.json'));

function isFcmProofBuild(environment) {
  const value = environment[FCM_PROOF_BUILD_ENV];

  if (value === undefined) {
    return false;
  }

  if (value === '1') {
    return true;
  }

  throw new Error(`${FCM_PROOF_BUILD_ENV} must be 1 when set`);
}

function isInsidePublicSource(filePath) {
  const sourceRelativePath = relative(PUBLIC_SOURCE_ROOT, filePath);

  return (
    sourceRelativePath === '' ||
    (!sourceRelativePath.startsWith(`..${sep}`) &&
      sourceRelativePath !== '..' &&
      !isAbsolute(sourceRelativePath))
  );
}

function readFirebaseClientConfiguration(filePath) {
  if (!isAbsolute(filePath)) {
    throw new Error(
      'Firebase client configuration must be an absolute path outside the public checkout',
    );
  }

  let resolvedFilePath;

  try {
    resolvedFilePath = realpathSync(filePath);
  } catch {
    throw new Error(`Firebase client configuration cannot be read`);
  }

  if (isInsidePublicSource(resolvedFilePath)) {
    throw new Error(
      'Firebase client configuration must be an absolute path outside the public checkout',
    );
  }

  let source;

  try {
    source = readFileSync(resolvedFilePath, 'utf8');
  } catch {
    throw new Error(`Firebase client configuration cannot be read`);
  }

  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`Firebase client configuration must be valid JSON`);
  }
}

function containsAndroidPackage(configuration, packageName) {
  if (!configuration || !Array.isArray(configuration.client)) {
    return false;
  }

  return configuration.client.some(
    (client) =>
      client?.client_info?.android_client_info?.package_name === packageName,
  );
}

function configureAndroidFcm(androidConfig, environment = process.env) {
  const proofBuild = isFcmProofBuild(environment);
  const googleServicesFile = environment[GOOGLE_SERVICES_FILE_ENV]?.trim();

  if (!googleServicesFile) {
    if (proofBuild) {
      throw new Error(`FCM proof build requires ${GOOGLE_SERVICES_FILE_ENV}`);
    }

    return androidConfig;
  }

  const configuration = readFirebaseClientConfiguration(googleServicesFile);

  if (!containsAndroidPackage(configuration, ANDROID_PACKAGE)) {
    throw new Error(
      `Firebase client configuration does not contain Android package ${ANDROID_PACKAGE}`,
    );
  }

  if (proofBuild) {
    if (
      parseReminderRegistrationEndpoint(
        environment[REMINDER_REGISTRATION_URL_ENV],
      ) === null
    ) {
      throw new Error(
        `FCM proof build requires valid ${REMINDER_REGISTRATION_URL_ENV} HTTPS endpoint`,
      );
    }

    const configuredRemoteInputs = REMOTE_TIME_ZONE_DATA_INPUTS.filter((name) =>
      environment[name]?.trim(),
    );

    if (
      configuredRemoteInputs.length > 0 &&
      configuredRemoteInputs.length < REMOTE_TIME_ZONE_DATA_INPUTS.length
    ) {
      const missingRemoteInputs = REMOTE_TIME_ZONE_DATA_INPUTS.filter(
        (name) => !environment[name]?.trim(),
      );

      throw new Error(
        `FCM proof build remote Time-Zone Data configuration requires ${missingRemoteInputs.join(', ')}`,
      );
    }

    if (
      configuredRemoteInputs.length === REMOTE_TIME_ZONE_DATA_INPUTS.length &&
      parseTimeZoneDataPackRemoteConfig({
        manifestUrl: environment.EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL,
        trustedKeysJson:
          environment.EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON,
      }) === null
    ) {
      throw new Error(
        'FCM proof build requires valid remote Time-Zone Data manifest URL and trusted keys',
      );
    }
  }

  return {
    ...androidConfig,
    googleServicesFile,
  };
}

module.exports = { configureAndroidFcm };
