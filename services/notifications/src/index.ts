import { app } from '@azure/functions';

import { healthOptions } from './health.js';

app.http('health', healthOptions);
