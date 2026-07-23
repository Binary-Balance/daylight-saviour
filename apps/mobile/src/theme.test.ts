import { daylightSaviourPalettes } from './theme';

describe('daylightSaviourPalettes', () => {
  it('assigns Civic White semantic roles without reusing signal red', () => {
    expect(daylightSaviourPalettes.light).toEqual({
      actionFill: '#101B2D',
      background: '#F7F8FA',
      decisionNoticeBorder: '#AAB2BC',
      decisionNoticeText: '#5B6678',
      ink: '#101B2D',
      noEventMark: '#5B6678',
      onActionFill: '#FFFFFF',
      rule: '#AAB2BC',
      secondaryInk: '#5B6678',
      signalRed: '#E5482D',
      solarGold: '#A66F00',
      solarGoldStructure: '#C99A22',
      surface: '#FFFFFF',
    });
  });

  it('retains existing dark appearance values through semantic roles', () => {
    expect(daylightSaviourPalettes.dark).toEqual({
      actionFill: '#FF6A4D',
      background: '#081426',
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
});
