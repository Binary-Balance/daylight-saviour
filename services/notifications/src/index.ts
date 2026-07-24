import { app } from '@azure/functions';

import { healthOptions } from './health.js';
import {
  reminderSubscriptionOptions,
  reminderThrottleCleanupOptions,
} from './reminder-subscriptions.js';

app.http('health', healthOptions);
app.http('reminder-subscriptions', reminderSubscriptionOptions);
app.timer('reminder-throttle-cleanup', reminderThrottleCleanupOptions);
