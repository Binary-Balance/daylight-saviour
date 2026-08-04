const {
  configureAndroidFcm,
  isFcmProofBuild,
} = require('./build/android-fcm-build-input.cjs');

function createAppConfig(config, environment = process.env) {
  const proofBuild = isFcmProofBuild(environment);
  return {
    ...config,
    android: configureAndroidFcm(config.android, environment),
    ...(proofBuild
      ? {
          extra: {
            ...config.extra,
            fcmTransportProofBuild: true,
          },
        }
      : {}),
  };
}

module.exports = ({ config }) => createAppConfig(config);
module.exports.createAppConfig = createAppConfig;
