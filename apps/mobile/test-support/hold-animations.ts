import * as ReactNative from 'react-native';

export interface HeldAnimation {
  // Whether the code under test started it.
  started: boolean;
  // Reports it as finished, as the native driver would when it completes.
  readonly finish: () => void;
  readonly stop: jest.Mock;
}

// Keeps each Animated.parallel animation in flight until the test finishes
// it, so the state between a change and the end of its animation can be seen.
// The Animated values the code created are real, so their start values show.
export function holdAnimations() {
  const held: HeldAnimation[] = [];
  jest.spyOn(ReactNative.Animated, 'parallel').mockImplementation((() => {
    let onFinished: ((result: { finished: boolean }) => void) | undefined;
    const animation: HeldAnimation = {
      started: false,
      finish: () => onFinished?.({ finished: true }),
      stop: jest.fn(),
    };
    held.push(animation);
    return {
      start: (callback?: (result: { finished: boolean }) => void) => {
        animation.started = true;
        onFinished = callback;
      },
      stop: animation.stop,
    };
  }) as never);
  return held;
}
