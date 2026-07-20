import type { ChangeDirection } from '@daylight-saviour/domain';

export interface CivilTimeReportMotionRecipe {
  readonly decorativeEcho: boolean;
  readonly durationMs: number;
  readonly kind: 'advance-grid-skip' | 'reverse-fading-echo' | 'short-fade';
  readonly repeats: 0;
  readonly travel: number;
}

export function createCivilTimeReportMotionRecipe(
  direction: ChangeDirection,
  reducedMotion: boolean,
): CivilTimeReportMotionRecipe {
  if (reducedMotion) {
    return {
      decorativeEcho: false,
      durationMs: 90,
      kind: 'short-fade',
      repeats: 0,
      travel: 0,
    };
  }

  return direction === 'Forward Change'
    ? {
        decorativeEcho: false,
        durationMs: 260,
        kind: 'advance-grid-skip',
        repeats: 0,
        travel: -12,
      }
    : {
        decorativeEcho: true,
        durationMs: 280,
        kind: 'reverse-fading-echo',
        repeats: 0,
        travel: 12,
      };
}
