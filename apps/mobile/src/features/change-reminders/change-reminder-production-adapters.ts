import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { parseReminderSubscriptionRegistrationResponse } from '@daylight-saviour/contracts';

import type { ChangeReminderAdapters } from './change-reminder-adapters';

const installationIdKey = 'reminder-installation-id-v1';
const credentialKey = 'reminder-installation-credential-v1';

export const productionChangeReminderAdapters: ChangeReminderAdapters = {
  async enable(homeTimeZone) {
    if (Platform.OS === 'web') return { kind: 'unavailable' };
    const existing = await Notifications.getPermissionsAsync();
    const permission = existing.granted
      ? existing
      : await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      return {
        kind: existing.canAskAgain ? 'permission-denied' : 'os-blocked',
      };
    }
    const endpoint = process.env.EXPO_PUBLIC_REMINDER_REGISTRATION_URL;
    if (endpoint === undefined || endpoint.length === 0)
      return { kind: 'failed' };
    try {
      const token = await Notifications.getDevicePushTokenAsync();
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          deviceToken: token.data,
          homeTimeZone,
          oneDayEnabled: true,
          oneWeekEnabled: true,
          platform: Platform.OS,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) return { kind: 'failed' };
      const registration = parseReminderSubscriptionRegistrationResponse(
        await response.json(),
      );
      await SecureStore.setItemAsync(
        installationIdKey,
        registration.installationId,
      );
      await SecureStore.setItemAsync(credentialKey, registration.credential);
      return { kind: 'enabled' };
    } catch {
      return { kind: 'failed' };
    }
  },
  async openSettings() {
    await Linking.openSettings();
  },
};
