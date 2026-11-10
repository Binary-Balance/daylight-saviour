import { contrastRatio } from '../test-support/contrast';
import { daylightSaviourPalettes } from './theme';

// Blends two #RRGGBB colours, as one drawn at `amount` opacity over the other.
function mix(under: string, over: string, amount: number) {
  const channel = (colour: string, index: number) =>
    parseInt(colour.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(
        channel(under, index) * (1 - amount) + channel(over, index) * amount,
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

describe('daylightSaviourPalettes', () => {
  it('assigns Civic White semantic roles without reusing signal red', () => {
    expect(daylightSaviourPalettes.light).toEqual({
      actionFill: '#101B2D',
      background: '#F7F8FA',
      controlBoundary: '#87919D',
      decisionNoticeBorder: '#AAB2BC',
      decisionNoticeGlow: '#FFE4B9',
      decisionNoticeGlowText: '#5B6678',
      decisionNoticeText: '#5B6678',
      ink: '#101B2D',
      noEventMark: '#5B6678',
      onActionFill: '#FFFFFF',
      rule: '#AAB2BC',
      secondaryInk: '#5B6678',
      signalRed: '#E5482D',
      solarGold: '#9A6700',
      solarGoldStructure: '#C99A22',
      surface: '#FFFFFF',
    });
  });

  it('retains existing dark appearance values through semantic roles', () => {
    expect(daylightSaviourPalettes.dark).toEqual({
      actionFill: '#FF6A4D',
      background: '#081426',
      controlBoundary: '#6F809B',
      decisionNoticeBorder: '#FF6A4D',
      decisionNoticeGlow: '#7C4140',
      decisionNoticeGlowText: '#F6F0DE',
      decisionNoticeText: '#FF6A4D',
      ink: '#F6F0DE',
      noEventMark: '#FF6A4D',
      onActionFill: '#FFF9EA',
      rule: '#405067',
      secondaryInk: '#B6C0CF',
      signalRed: '#FF6A4D',
      solarGold: '#FF6A4D',
      solarGoldStructure: '#FFB238',
      surface: '#101F35',
    });
  });

  it('keeps light gold text and neutral controls above contrast thresholds', () => {
    const palette = daylightSaviourPalettes.light;

    expect(
      contrastRatio(palette.solarGold, palette.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(palette.solarGold, palette.surface),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(palette.controlBoundary, palette.background),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(palette.controlBoundary, palette.surface),
    ).toBeGreaterThanOrEqual(3);
  });

  // The glow and the heading's glow colour fade out together, so check
  // every step of the fade, not just its ends.
  it.each(['light', 'dark'] as const)(
    'keeps %s reminder notice text readable throughout its glow',
    (appearance) => {
      const palette = daylightSaviourPalettes[appearance];
      for (let step = 0; step <= 20; step += 1) {
        const glow = step / 20;
        const background = mix(
          palette.surface,
          palette.decisionNoticeGlow,
          glow,
        );
        const heading = mix(
          palette.decisionNoticeText,
          palette.decisionNoticeGlowText,
          glow,
        );
        expect(contrastRatio(heading, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.ink, background)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );

  it('keeps dark gold rules and neutral controls above contrast thresholds', () => {
    const palette = daylightSaviourPalettes.dark;
    expect(
      contrastRatio(palette.solarGoldStructure, palette.background),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(palette.solarGoldStructure, palette.surface),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(palette.controlBoundary, palette.background),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(palette.controlBoundary, palette.surface),
    ).toBeGreaterThanOrEqual(3);
  });
});
