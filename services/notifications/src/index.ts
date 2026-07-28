import { app } from '@azure/functions';

import { fcmProofOptions } from './fcm-runtime.js';
import { healthOptions } from './health.js';
import {
  reminderSubscriptionOptions,
  reminderSubscriptionUpdateOptions,
  reminderThrottleCleanupOptions,
} from './reminder-subscriptions.js';

app.http('health', healthOptions);
app.http('fcm-proof', fcmProofOptions);
app.http('reminder-subscriptions', reminderSubscriptionOptions);
app.http('reminder-subscription-update', reminderSubscriptionUpdateOptions);
app.timer('reminder-throttle-cleanup', reminderThrottleCleanupOptions);
