import Constants from 'expo-constants';

/** Build-time Expo configuration; no runtime or remote toggle can enable it. */
export const fcmTransportProofBuild =
  Constants.expoConfig?.extra?.fcmTransportProofBuild === true;
