import { app } from '@azure/functions';

import { controlledReminderSmokeOptions } from './controlled-reminder-smoke.ts';
import { healthOptions } from './health.ts';
import { reminderCleanupTimerOptions } from './reminder-cleanup-timer.ts';
import { reminderDispatchTimerOptions } from './reminder-dispatch-timer.ts';
import {
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
app.timer('reminder-throttle-cleanup', reminderCleanupTimerOptions);
