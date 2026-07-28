const { configureAndroidFcm } = require('./build/android-fcm-build-input.cjs');

module.exports = ({ config }) => ({
  ...config,
  android: configureAndroidFcm(config.android),
});
