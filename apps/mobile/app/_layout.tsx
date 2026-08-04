import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import '../src/features/change-reminders/fcm-transport-proof-background';

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </>
  );
}
