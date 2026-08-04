import { createFcmTransportProofDiagnosticReader } from './change-reminder-production-adapters';

const storedRegistration = {
  attemptGeneration: 1,
  credential: 'c'.repeat(43),
  deviceToken: 'fcm-token:with_valid.characters-123',
  homeTimeZone: 'Australia/Sydney',
  installationId: 'i'.repeat(43),
  oneDayEnabled: true,
  oneWeekEnabled: true,
  registrationRequestId: 'a'.repeat(64),
  state: 'registered',
  version: 4,
} as const;

describe('FCM transport proof diagnostic reader', () => {
  it('projects only installation ID and matching Home Time Zone', async () => {
    const reader = createFcmTransportProofDiagnosticReader({
      getItemAsync: jest.fn(async () => JSON.stringify(storedRegistration)),
    });

    const result = await reader.read('Australia/Sydney');

    expect(result).toEqual({
      homeTimeZone: 'Australia/Sydney',
      installationId: 'i'.repeat(43),
    });
    expect(result).not.toHaveProperty('credential');
    expect(result).not.toHaveProperty('deviceToken');
  });

  it('fails closed for mismatch, pending, malformed, or unavailable state', async () => {
    for (const value of [
      null,
      'malformed',
      JSON.stringify({ ...storedRegistration, state: 'pending' }),
    ]) {
      const reader = createFcmTransportProofDiagnosticReader({
        getItemAsync: jest.fn(async () => value),
      });
      await expect(reader.read('Australia/Sydney')).resolves.toBeNull();
    }
    const reader = createFcmTransportProofDiagnosticReader({
      getItemAsync: jest.fn(async () => JSON.stringify(storedRegistration)),
    });
    await expect(reader.read('Australia/Perth')).resolves.toBeNull();
  });
});
