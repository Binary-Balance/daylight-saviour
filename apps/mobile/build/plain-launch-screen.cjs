const { withAndroidStyles, withMod } = require('expo/config-plugins');

// expo-splash-screen 57.0.11 mishandles a launch screen with no image:
// - Android keeps windowSplashScreenAnimatedIcon pointing at a
//   splashscreen_logo drawable it never writes, so resource linking fails.
//   Dropping the item is no better: core-splashscreen then shows Android's
//   generic sym_def_app_icon. Point it at the launcher icon instead, which is
//   what Android 12 and later shows by default. Below Android 12,
//   core-splashscreen masks the already-masked adaptive icon again, so the
//   rays are likely cropped there; accepted for a sub-second screen.
// - iOS leaves the storyboard on systemBackgroundColor (white or black) and
//   keeps the removed logo's constraints and image resource.
// List this plugin before expo-splash-screen in app.json: a later plugin's
// mods run first, so these edits would otherwise be overwritten (Android) or
// refused, since expo-splash-screen adds the storyboard reader last (iOS).
// Delete this plugin once expo-splash-screen handles a plain background.

const STORYBOARD_LOGO_ID = 'EXPO-SplashScreen';
const STORYBOARD_BACKGROUND = 'SplashScreenBackground';

function setSplashIconToLauncherIcon(styles) {
  for (const style of styles.resources.style ?? []) {
    if (style.$.name !== 'Theme.App.SplashScreen') continue;
    for (const item of style.item ?? []) {
      if (item.$.name === 'windowSplashScreenAnimatedIcon') {
        item._ = '@mipmap/ic_launcher';
      }
    }
  }
  return styles;
}

function setStoryboardBackground(storyboard) {
  const view =
    storyboard.document.scenes[0].scene[0].objects[0].viewController[0].view[0];
  view.color = [{ $: { key: 'backgroundColor', name: STORYBOARD_BACKGROUND } }];
  if (view.constraints?.[0]?.constraint) {
    view.constraints[0].constraint = view.constraints[0].constraint.filter(
      (constraint) => constraint.$.firstItem !== STORYBOARD_LOGO_ID,
    );
  }

  // Interface Builder needs the named colour declared; the asset catalog
  // supplies the real light and dark values at runtime.
  const resources = storyboard.document.resources[0];
  delete resources.image;
  delete resources.systemColor;
  resources.namedColor = [
    {
      $: { name: STORYBOARD_BACKGROUND },
      color: [
        {
          $: {
            alpha: '1.000',
            blue: '1.000',
            colorSpace: 'custom',
            customColorSpace: 'sRGB',
            green: '1.000',
            red: '1.000',
          },
        },
      ],
    },
  ];
  return storyboard;
}

function withPlainLaunchScreen(config) {
  config = withAndroidStyles(config, (modConfig) => {
    modConfig.modResults = setSplashIconToLauncherIcon(modConfig.modResults);
    return modConfig;
  });
  // expo-splash-screen supplies the parsed storyboard under this mod name.
  return withMod(config, {
    action: (modConfig) => {
      modConfig.modResults = setStoryboardBackground(modConfig.modResults);
      return modConfig;
    },
    mod: 'splashScreenStoryboard',
    platform: 'ios',
  });
}

module.exports = withPlainLaunchScreen;
module.exports.setSplashIconToLauncherIcon = setSplashIconToLauncherIcon;
module.exports.setStoryboardBackground = setStoryboardBackground;
