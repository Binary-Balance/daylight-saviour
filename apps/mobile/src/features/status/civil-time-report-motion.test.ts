import { createCivilTimeReportMotionRecipe } from './civil-time-report-motion';

describe('Civil Time Report semantic motion', () => {
  it('advances and skips once for a Forward Change', () => {
    expect(createCivilTimeReportMotionRecipe('Forward Change', false)).toEqual({
      decorativeEcho: false,
      durationMs: 260,
      kind: 'advance-grid-skip',
      repeats: 0,
      travel: -12,
    });
  });

  it('reverses with one decorative echo for a Backward Change', () => {
    expect(createCivilTimeReportMotionRecipe('Backward Change', false)).toEqual(
      {
        decorativeEcho: true,
        durationMs: 280,
        kind: 'reverse-fading-echo',
        repeats: 0,
        travel: 12,
      },
    );
  });

  it.each(['Forward Change', 'Backward Change'] as const)(
    'removes directional displacement and echoes under reduced motion for %s',
    (direction) => {
      expect(createCivilTimeReportMotionRecipe(direction, true)).toEqual({
        decorativeEcho: false,
        durationMs: 90,
        kind: 'short-fade',
        repeats: 0,
        travel: 0,
      });
    },
  );
});
