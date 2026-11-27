import { screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { displayTextMaxSize } from '../src/theme';

// Lists every rendered text whose growth limit breaks the display text rule:
// text larger than 17 pt body text stops at the display maximum, and smaller
// text has no limit. The clock is exempt: it scrolls sideways instead of
// wrapping.
export function textBreakingDisplayLimit() {
  return screen.UNSAFE_root.findAllByType(Text)
    .filter((node) => !String(node.props.testID).startsWith('clock-'))
    .map((node) => {
      const { fontSize = 14 } = StyleSheet.flatten(node.props.style);
      return {
        expected: fontSize > 17 ? displayTextMaxSize / fontSize : undefined,
        fontSize,
        limit: node.props.maxFontSizeMultiplier,
        text: node.props.children,
      };
    })
    .filter(({ expected, limit }) => limit !== expected);
}
