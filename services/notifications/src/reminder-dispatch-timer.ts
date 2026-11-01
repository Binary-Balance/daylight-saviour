import type { InvocationContext, TimerFunctionOptions } from '@azure/functions';

type ReminderDispatchRunner = (context: InvocationContext) => Promise<void>;

// Loaded on the first enabled run, so a fault in the runtime cannot stop the
// registration functions loading, and a suspended timer needs no provider or
// Time-Zone Data Pack configuration.
async function loadRunner(): Promise<ReminderDispatchRunner> {
  const { createReminderDispatchRunner } =
    await import('./reminder-dispatch-runtime.ts');
  return createReminderDispatchRunner();
}

export function createReminderDispatchTimerHandler(
  environment: NodeJS.ProcessEnv = process.env,
  load: () => Promise<ReminderDispatchRunner> = loadRunner,
) {
  let cachedRunner: ReminderDispatchRunner | undefined;

  return async (_timer: unknown, context: InvocationContext): Promise<void> => {
    // Dispatch stays off until an operator enables it, so deploying this
    // function cannot send anything. A missing or invalid value suspends it.
    if (environment.REMINDER_DISPATCH_ENABLED !== 'true') {
      context.log('reminder-dispatch-suspended');
      return;
    }
    try {
      // A warm worker keeps the APNs JWT cache. Do not cache a failure:
      // transient configuration access may recover.
      const run = cachedRunner ?? (cachedRunner = await load());
      await run(context);
    } catch {
      // A fixed event keeps configuration detail out of the log.
      context.log('reminder-dispatch-unavailable');
    }
  };
}

export const reminderDispatchTimerOptions: TimerFunctionOptions = {
  handler: createReminderDispatchTimerHandler(),
  schedule: '0 */5 * * * *',
  useMonitor: true,
};
