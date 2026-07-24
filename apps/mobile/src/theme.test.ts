import { daylightSaviourPalettes } from './theme';

function relativeLuminance(hex: string) {
  const channels = hex
    .match(/[a-f\d]{2}/gi)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (channels === undefined || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex colour, received ${hex}`);
  }
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe('daylightSaviourPalettes', () => {
  it('assigns Civic White semantic roles without reusing signal red', () => {
    expect(daylightSaviourPalettes.light).toEqual({
      actionFill: '#101B2D',
      background: '#F7F8FA',
      controlBoundary: '#87919D',
      decisionNoticeBorder: '#AAB2BC',
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
      controlBoundary: '#405067',
      decisionNoticeBorder: '#FF6A4D',
      decisionNoticeText: '#FF6A4D',
      ink: '#F6F0DE',
      noEventMark: '#FF6A4D',
      onActionFill: '#FFF9EA',
      rule: '#405067',
      secondaryInk: '#B6C0CF',
      signalRed: '#FF6A4D',
      solarGold: '#FF6A4D',
      solarGoldStructure: '#405067',
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
});
