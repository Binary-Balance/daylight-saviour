import { fireEvent, render, screen } from '@testing-library/react-native';

import { daylightSaviourPalettes } from '../../theme';
import DataFreshnessSection, {
  type DataFreshnessFacts,
} from './data-freshness-section';

const currentFacts: DataFreshnessFacts = {
  freshness: 'current',
  packVersion: '2026a-test.1',
  remoteEnabled: true,
  source: 'bundled',
  uses24hourClock: false,
  validUntil: '2030-12-31T23:59:59.000Z',
};

describe('DataFreshnessSection', () => {
  it.each([
    ['checking', 'Checking for verified data…'],
    ['stale-valid', 'Verified data due for refresh'],
    ['offline-valid', 'Offline · verified data remains valid'],
    ['retry-failed', 'Refresh failed · verified data remains active'],
  ] as const)('renders %s facts', (freshness, expectedStatus) => {
    render(
      <DataFreshnessSection
        facts={{ ...currentFacts, freshness }}
        palette={daylightSaviourPalettes.light}
      />,
    );

    expect(screen.getByText(expectedStatus)).toBeTruthy();
    expect(screen.getByLabelText(/Time-Zone Data Pack/)).toBeTruthy();
  });

  it('keeps manual retry focusable beside freshness facts', () => {
    const retry = jest.fn();
    render(
      <DataFreshnessSection
        facts={{ ...currentFacts, freshness: 'retry-failed' }}
        onRetry={retry}
        palette={daylightSaviourPalettes.dark}
      />,
    );

    expect(
      screen.getByLabelText(/Time-Zone Data Pack .*refresh failed/),
    ).toBeTruthy();
    const button = screen.getByRole('button', {
      name: 'Retry Time-Zone Data Pack refresh',
    });
    fireEvent.press(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('disables retry while checking and omits it without remote refresh', () => {
    const retry = jest.fn();
    const rendered = render(
      <DataFreshnessSection
        facts={{ ...currentFacts, freshness: 'checking' }}
        onRetry={retry}
        palette={daylightSaviourPalettes.light}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: 'Retry Time-Zone Data Pack refresh',
      }),
    ).toBeDisabled();

    rendered.rerender(
      <DataFreshnessSection
        facts={{ ...currentFacts, remoteEnabled: false }}
        onRetry={retry}
        palette={daylightSaviourPalettes.light}
      />,
    );
    expect(
      screen.queryByRole('button', {
        name: 'Retry Time-Zone Data Pack refresh',
      }),
    ).toBeNull();
  });
});
