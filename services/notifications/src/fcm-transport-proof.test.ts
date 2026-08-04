import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFcmTransportProof } from './fcm-transport-proof.js';

describe('FCM transport proof', () => {
  it('resolves one environment-selected registration and sends its stored zone', async () => {
    const registration = {
      deviceToken: 'fcm-token:stored-registration-value-123',
      homeTimeZone: 'Australia/Sydney',
      installationId: 'a'.repeat(43),
    };
    const resolutions: string[] = [];
    const sends: unknown[] = [];
    const proof = createFcmTransportProof(registration.installationId, {
      registrationResolver: {
        getFcmProofSubscription: async (installationId) => {
          resolutions.push(installationId);
          return registration;
        },
      },
      sender: {
        sendTransportProof: async (...input) => {
          sends.push(input);
          return { kind: 'accepted' };
        },
      },
    });

    assert.deepEqual(await proof.send(), { kind: 'accepted' });
    assert.deepEqual(resolutions, [registration.installationId]);
    assert.deepEqual(sends, [[registration, 'Australia/Sydney']]);
  });

  it('does not dispatch when selected registration is unavailable', async () => {
    let sends = 0;
    const proof = createFcmTransportProof('a'.repeat(43), {
      registrationResolver: {
        getFcmProofSubscription: async () => null,
      },
      sender: {
        sendTransportProof: async () => {
          sends += 1;
          return { kind: 'accepted' };
        },
      },
    });

    assert.equal(await proof.send(), null);
    assert.equal(sends, 0);
  });
});
