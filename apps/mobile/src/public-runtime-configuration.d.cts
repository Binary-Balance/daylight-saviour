export function decodeCanonicalBase64(
  value: string,
  maximumBytes: number,
): Uint8Array | null;

export function parseReminderRegistrationEndpoint(
  value: string | undefined,
): string | null;

export function parseTimeZoneDataPackRemoteConfig(input: {
  readonly manifestUrl: string | undefined;
  readonly trustedKeysJson: string | undefined;
}): {
  readonly manifestUrl: string;
  readonly trustedKeys: Readonly<Record<string, string>>;
} | null;
