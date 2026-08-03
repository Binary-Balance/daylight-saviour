function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64Value(character) {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === '+' ? 62 : 63;
}

function decodeCanonicalBase64(value, maximumBytes) {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > maximumBytes) return null;
  if (
    (padding === 2 &&
      (base64Value(value.charAt(value.length - 3)) & 15) !== 0) ||
    (padding === 1 && (base64Value(value.charAt(value.length - 2)) & 3) !== 0)
  ) {
    return null;
  }
  const bytes = new Uint8Array(decodedLength);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Value(value.charAt(index));
    const second = base64Value(value.charAt(index + 1));
    const third =
      value.charAt(index + 2) === '='
        ? 0
        : base64Value(value.charAt(index + 2));
    const fourth =
      value.charAt(index + 3) === '='
        ? 0
        : base64Value(value.charAt(index + 3));
    const decoded = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < decodedLength) bytes[outputIndex++] = decoded >>> 16;
    if (outputIndex < decodedLength) bytes[outputIndex++] = decoded >>> 8;
    if (outputIndex < decodedLength) bytes[outputIndex++] = decoded;
  }
  return bytes;
}

function parseReminderRegistrationEndpoint(value) {
  if (value === undefined || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isCanonicalRawPublicKey(value) {
  return (
    typeof value === 'string' &&
    decodeCanonicalBase64(value, 32)?.byteLength === 32
  );
}

function parseTimeZoneDataPackRemoteConfig({ manifestUrl, trustedKeysJson }) {
  if (manifestUrl === undefined || trustedKeysJson === undefined) return null;
  try {
    const url = new URL(manifestUrl);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    const parsed = JSON.parse(trustedKeysJson);
    if (!isRecord(parsed)) return null;
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 ||
      entries.some(
        ([keyId, publicKey]) =>
          !/^[A-Za-z0-9._-]{1,100}$/.test(keyId) ||
          !isCanonicalRawPublicKey(publicKey),
      )
    ) {
      return null;
    }
    return {
      manifestUrl: url.toString(),
      trustedKeys: Object.freeze(Object.fromEntries(entries)),
    };
  } catch {
    return null;
  }
}

module.exports = {
  decodeCanonicalBase64,
  parseReminderRegistrationEndpoint,
  parseTimeZoneDataPackRemoteConfig,
};
