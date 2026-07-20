export const settings = Object.freeze({
  accessibility: Object.freeze({
    openHint: 'Opens compact app and data details',
    openLabel: 'Settings',
  }),
  appDetailsHeading: 'APP DETAILS',
  closeButton: 'Close settings',
  heading: 'Settings',
  homeTimeZone: (friendlyZoneLabel: string) =>
    `Home Time Zone: ${friendlyZoneLabel}`,
  openButton: 'SETTINGS',
  timeZoneDataPack: (packVersion: string) =>
    `Time-Zone Data Pack: ${packVersion}`,
});
