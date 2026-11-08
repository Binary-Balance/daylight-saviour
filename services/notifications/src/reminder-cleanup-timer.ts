import type { InvocationContext, TimerFunctionOptions } from '@azure/functions';

import {
  createAzureReminderDispatchLedgerStore,
  type ReminderDispatchLedgerStore,
} from './reminder-dispatch-ledger.ts';
import {
  createAzureReminderSubscriptionStore,
  type ReminderSubscriptionStore,
} from './reminder-subscriptions.ts';

export function createReminderCleanupTimerHandler(
  environment: NodeJS.ProcessEnv = process.env,
  createSubscriptions: () => ReminderSubscriptionStore = createAzureReminderSubscriptionStore,
  createLedger: () => Pick<
    ReminderDispatchLedgerStore,
    'purgeExpired'
  > = createAzureReminderDispatchLedgerStore,
) {
  return async (_timer: unknown, context: InvocationContext): Promise<void> => {
    const now = new Date();
    const subscriptions = createSubscriptions();
    await subscriptions.purgeExpiredThrottleRecords(now);
    await subscriptions.purgeExpiredRetiredSubscriptions(now);
    const unreadable = await createLedger().purgeExpired(now);
    // The event settlement logs for an unreadable row, so one alert covers both.
    if (unreadable > 0) {
      context.log(`reminder-dispatch-ledger-row-invalid count=${unreadable}`);
    }
    // ADR 0022 expires a subscription only after warning it, so expiry stays
    // off until an operator enables it once dispatch can deliver the warning.
    // It runs last, so a failure here cannot stop the purges.
    if (environment.REMINDER_SUBSCRIPTION_EXPIRY_ENABLED === 'true') {
      const expired = await subscriptions.expireSilentSubscriptions(now);
      // Logged even at zero, so a quiet run differs from one that never ran.
      context.log(`reminder-subscriptions-expired count=${expired}`);
    }
  };
}

export const reminderCleanupTimerOptions: TimerFunctionOptions = {
  handler: createReminderCleanupTimerHandler(),
  schedule: '0 17 3 * * *',
  useMonitor: true,
};
