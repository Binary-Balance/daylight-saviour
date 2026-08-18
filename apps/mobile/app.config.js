const { configureAndroidFcm } = require('./build/android-fcm-build-input.cjs');

function createAppConfig(config, environment = process.env) {
  return {
    ...config,
    android: configureAndroidFcm(config.android, environment),
  };
}

module.exports = ({ config }) => createAppConfig(config);
module.exports.createAppConfig = createAppConfig;
