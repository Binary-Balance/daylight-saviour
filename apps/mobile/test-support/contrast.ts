function linearChannel(hexPair: string) {
  const channel = Number.parseInt(hexPair, 16) / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string) {
  const [red, green, blue, extra] =
    hex.match(/[a-f\d]{2}/gi)?.map(linearChannel) ?? [];
  if (
    red === undefined ||
    green === undefined ||
    blue === undefined ||
    extra !== undefined
  ) {
    throw new Error(`Expected a six-digit hex colour, received ${hex}`);
  }
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrastRatio(foreground: string, background: string) {
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
