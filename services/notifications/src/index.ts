import { app } from '@azure/functions';

import { controlledReminderSmokeOptions } from './controlled-reminder-smoke.ts';
import { healthOptions } from './health.ts';
import {
  reminderSubscriptionDeleteOptions,
  reminderSubscriptionOptions,
  reminderSubscriptionUpdateOptions,
  reminderThrottleCleanupOptions,
} from './reminder-subscriptions.ts';

app.http('health', healthOptions);
app.http('controlled-reminder-smoke', controlledReminderSmokeOptions);
app.http('reminder-subscriptions', reminderSubscriptionOptions);
app.http('reminder-subscription-update', reminderSubscriptionUpdateOptions);
app.http('reminder-subscription-delete', reminderSubscriptionDeleteOptions);
app.timer('reminder-throttle-cleanup', reminderThrottleCleanupOptions);
