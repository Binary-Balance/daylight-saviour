import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox } from 'react-native';

import { screenshotModeEnabled } from '../src/features/screenshots/screenshot-mode';

// Development warnings would otherwise appear in the captures.
if (screenshotModeEnabled()) LogBox.ignoreAllLogs();

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </>
  );
}
