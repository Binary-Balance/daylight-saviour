import { app } from '@azure/functions';

import { controlledReminderSmokeOptions } from './controlled-reminder-smoke.ts';
import { healthOptions } from './health.ts';
import { createAzureReminderDispatchLedgerStore } from './reminder-dispatch-ledger.ts';
import { reminderDispatchTimerOptions } from './reminder-dispatch-timer.ts';
import {
  createAzureReminderSubscriptionStore,
  reminderSubscriptionCheckInOptions,
  reminderSubscriptionDeleteOptions,
  reminderSubscriptionOptions,
  reminderSubscriptionUpdateOptions,
} from './reminder-subscriptions.ts';

app.http('health', healthOptions);
app.http('controlled-reminder-smoke', controlledReminderSmokeOptions);
app.http('reminder-subscriptions', reminderSubscriptionOptions);
app.http('reminder-subscription-update', reminderSubscriptionUpdateOptions);
app.http('reminder-subscription-delete', reminderSubscriptionDeleteOptions);
app.http('reminder-subscription-check-in', reminderSubscriptionCheckInOptions);
app.timer('reminder-dispatch', reminderDispatchTimerOptions);
// The name predates ledger retention; renaming would replace the deployed
// function and its monitoring history.
app.timer('reminder-throttle-cleanup', {
  handler: async (_timer, context) => {
    const now = new Date();
    const subscriptions = createAzureReminderSubscriptionStore();
    await subscriptions.purgeExpiredThrottleRecords(now);
    await subscriptions.purgeExpiredRetiredSubscriptions(now);
    const unreadable =
      await createAzureReminderDispatchLedgerStore().purgeExpired(now);
    // The event settlement logs for an unreadable row, so one alert covers both.
    if (unreadable > 0) {
      context.log(`reminder-dispatch-ledger-row-invalid count=${unreadable}`);
    }
  },
  schedule: '0 17 3 * * *',
  useMonitor: true,
});
