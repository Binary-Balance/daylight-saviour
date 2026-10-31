import { app } from '@azure/functions';

import { controlledReminderSmokeOptions } from './controlled-reminder-smoke.ts';
import { healthOptions } from './health.ts';
import { createAzureReminderDispatchLedgerStore } from './reminder-dispatch-ledger.ts';
import { reminderDispatchTimerOptions } from './reminder-dispatch-timer.ts';
import {
  createAzureReminderSubscriptionStore,
  reminderSubscriptionDeleteOptions,
  reminderSubscriptionOptions,
  reminderSubscriptionUpdateOptions,
} from './reminder-subscriptions.ts';

app.http('health', healthOptions);
app.http('controlled-reminder-smoke', controlledReminderSmokeOptions);
app.http('reminder-subscriptions', reminderSubscriptionOptions);
app.http('reminder-subscription-update', reminderSubscriptionUpdateOptions);
app.http('reminder-subscription-delete', reminderSubscriptionDeleteOptions);
app.timer('reminder-dispatch', reminderDispatchTimerOptions);
// The name predates ledger retention; renaming would replace the deployed
// function and its monitoring history.
app.timer('reminder-throttle-cleanup', {
  handler: async () => {
    const now = new Date();
    const subscriptions = createAzureReminderSubscriptionStore();
    await subscriptions.purgeExpiredThrottleRecords(now);
    await subscriptions.purgeExpiredRetiredSubscriptions(now);
    await createAzureReminderDispatchLedgerStore().purgeExpired(now);
  },
  schedule: '0 17 3 * * *',
  useMonitor: true,
});
