export const daylightSaviourPalettes = {
  light: {
    accent: '#E5482D',
    background: '#F4EEDC',
    ink: '#111B2C',
    rule: '#A9A38F',
    secondaryInk: '#596273',
    surface: '#FFF9EA',
  },
  dark: {
    accent: '#FF6A4D',
    background: '#081426',
    ink: '#F6F0DE',
    rule: '#405067',
    secondaryInk: '#B6C0CF',
    surface: '#101F35',
  },
} as const;

export type DaylightSaviourPalette =
  (typeof daylightSaviourPalettes)[keyof typeof daylightSaviourPalettes];
