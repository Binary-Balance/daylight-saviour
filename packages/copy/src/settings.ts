export const settings = Object.freeze({
  accessibility: Object.freeze({
    openHint: 'Opens compact app and data details',
    openLabel: 'Settings',
  }),
  appDetailsHeading: 'App details',
  closeButton: 'Close settings',
  heading: 'Settings',
  homeTimeZone: (friendlyZoneLabel: string) =>
    `Home Time Zone: ${friendlyZoneLabel}`,
  openButton: 'Settings',
});
