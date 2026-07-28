const { readFileSync, realpathSync } = require('node:fs');
const { dirname, isAbsolute, relative, sep } = require('node:path');

const ANDROID_PACKAGE = 'au.com.binarybalance.daylightsaviour';
const GOOGLE_SERVICES_FILE_ENV =
  'DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE';
const FCM_PROOF_BUILD_ENV = 'DAYLIGHT_SAVIOUR_FCM_PROOF_BUILD';
const FCM_PROOF_RUNTIME_INPUTS = [
  'EXPO_PUBLIC_REMINDER_REGISTRATION_URL',
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
    const missingRuntimeInputs = FCM_PROOF_RUNTIME_INPUTS.filter(
      (name) => !environment[name]?.trim(),
    );

    if (missingRuntimeInputs.length > 0) {
      throw new Error(
        `FCM proof build requires ${missingRuntimeInputs.join(', ')}`,
      );
    }
  }

  return {
    ...androidConfig,
    googleServicesFile,
  };
}

module.exports = { configureAndroidFcm };
