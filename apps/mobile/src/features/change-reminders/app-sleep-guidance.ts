import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { AppSleepAdapters, AppSleepPrompt } from './app-sleep-adapters';

// Android first: the app knows that problem is real, but can only guess at
// Samsung's.
const prompts: readonly AppSleepPrompt[] = ['android-pause', 'samsung-sleep'];

interface AppSleepFacts {
  readonly answered: ReadonlySet<AppSleepPrompt>;
  readonly applicable: ReadonlySet<AppSleepPrompt>;
}

async function readFacts(adapters: AppSleepAdapters): Promise<AppSleepFacts> {
  const [canPause, answered] = await Promise.all([
    adapters.canPauseApp().catch(() => false),
    Promise.all(
      prompts.map((prompt) =>
        adapters.answeredPrompts.load(prompt).catch(() => false),
      ),
    ),
  ]);
  return {
    answered: new Set(prompts.filter((_, index) => answered[index])),
    applicable: new Set(
      prompts.filter((prompt) =>
        prompt === 'android-pause'
          ? canPause
          : adapters.canOpenNeverSleepingApps(),
      ),
    ),
  };
}

export interface AppSleepGuidance {
  readonly androidApiLevel: number;
  /** The prompt to show, until the user answers it. */
  readonly prompt: AppSleepPrompt | undefined;
  /** Reminder lines for answered prompts, shown once no prompt is waiting. */
  readonly lines: readonly AppSleepPrompt[];
  readonly answer: (prompt: AppSleepPrompt) => void;
  readonly openSetting: (prompt: AppSleepPrompt) => void;
}

/**
 * What to tell the user about settings that stop reminders arriving. Rereads
 * the pause status on each return to the app, so the guidance goes once the
 * user turns the setting off.
 */
export function useAppSleepGuidance(
  adapters: AppSleepAdapters | null,
): AppSleepGuidance | null {
  const [facts, setFacts] = useState<AppSleepFacts | null>(null);
  // Answers given since launch, so a failed or slow save cannot bring a
  // prompt back.
  const [answeredNow, setAnsweredNow] = useState<ReadonlySet<AppSleepPrompt>>(
    new Set(),
  );

  useEffect(() => {
    if (adapters === null) return;
    let active = true;
    const refresh = () => {
      void readFacts(adapters).then(
        (next) => {
          if (active) setFacts(next);
        },
        () => undefined,
      );
    };
    refresh();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') refresh();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [adapters]);

  if (adapters === null) return null;
  const applicable = prompts.filter((prompt) => facts?.applicable.has(prompt));
  const prompt = applicable.find(
    (candidate) =>
      !facts?.answered.has(candidate) && !answeredNow.has(candidate),
  );
  return {
    androidApiLevel: adapters.androidApiLevel,
    answer: (answered) => {
      setAnsweredNow((previous) => new Set(previous).add(answered));
      void adapters.answeredPrompts.save(answered).catch(() => undefined);
    },
    lines: prompt === undefined ? applicable : [],
    openSetting: (setting) => {
      void (
        setting === 'android-pause'
          ? adapters.openPauseSetting()
          : adapters.openNeverSleepingApps()
      ).catch(() => undefined);
    },
    prompt,
  };
}
