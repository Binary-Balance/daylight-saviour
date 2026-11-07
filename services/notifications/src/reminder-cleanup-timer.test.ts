import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createReminderCleanupTimerHandler } from './reminder-cleanup-timer.ts';
import type { ReminderSubscriptionStore } from './reminder-subscriptions.ts';

function runCleanup(environment: NodeJS.ProcessEnv, unreadableLedgerRows = 0) {
  const calls: string[] = [];
  const logs: unknown[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  const handler = createReminderCleanupTimerHandler(
    environment,
    () =>
      ({
        expireSilentSubscriptions: record('expire'),
        purgeExpiredRetiredSubscriptions: record('purge-retired'),
        purgeExpiredThrottleRecords: record('purge-throttles'),
      }) as unknown as ReminderSubscriptionStore,
    () => ({
      purgeExpired: async () => {
        calls.push('purge-ledger');
        return unreadableLedgerRows;
      },
    }),
  );
  return handler(undefined, {
    log: (line: unknown) => logs.push(line),
  } as never).then(() => ({ calls, logs }));
}

describe('reminder cleanup timer', () => {
  for (const setting of [undefined, '', 'false', 'TRUE', ' true']) {
    it(`expires nothing when expiry is ${JSON.stringify(setting)}`, async () => {
      const { calls } = await runCleanup(
        setting === undefined
          ? {}
          : { REMINDER_SUBSCRIPTION_EXPIRY_ENABLED: setting },
      );

      assert.deepEqual(calls, [
        'purge-throttles',
        'purge-retired',
        'purge-ledger',
      ]);
    });
  }

  it('expires silent subscriptions after the purges when enabled', async () => {
    const { calls } = await runCleanup({
      REMINDER_SUBSCRIPTION_EXPIRY_ENABLED: 'true',
    });

    assert.deepEqual(calls, [
      'purge-throttles',
      'purge-retired',
      'purge-ledger',
      'expire',
    ]);
  });

  it('logs how many ledger rows could not be read', async () => {
    assert.deepEqual((await runCleanup({}, 0)).logs, []);
    assert.deepEqual((await runCleanup({}, 2)).logs, [
      'reminder-dispatch-ledger-row-invalid count=2',
    ]);
  });
});
