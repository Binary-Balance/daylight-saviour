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

module.exports = { parseReminderRegistrationEndpoint };
