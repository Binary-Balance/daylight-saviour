const { readFileSync, realpathSync } = require('node:fs');
const { dirname, isAbsolute, relative, sep } = require('node:path');

const ANDROID_PACKAGE = 'au.com.binarybalance.daylightsaviour';
const GOOGLE_SERVICES_FILE_ENV =
  'DAYLIGHT_SAVIOUR_ANDROID_GOOGLE_SERVICES_FILE';
const PUBLIC_SOURCE_ROOT = dirname(require.resolve('../../../package.json'));

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
  const googleServicesFile = environment[GOOGLE_SERVICES_FILE_ENV]?.trim();

  if (!googleServicesFile) {
    return androidConfig;
  }

  const configuration = readFirebaseClientConfiguration(googleServicesFile);

  if (!containsAndroidPackage(configuration, ANDROID_PACKAGE)) {
    throw new Error(
      `Firebase client configuration does not contain Android package ${ANDROID_PACKAGE}`,
    );
  }

  return {
    ...androidConfig,
    googleServicesFile,
  };
}

module.exports = { configureAndroidFcm };
