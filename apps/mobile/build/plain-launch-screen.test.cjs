const assert = require('node:assert/strict');
const test = require('node:test');
const { XML } = require('expo/config-plugins');

const {
  setSplashIconToLauncherIcon,
  setStoryboardBackground,
} = require('./plain-launch-screen.cjs');

test('points only the splash theme icon at the launcher icon', async () => {
  const styles = await XML.parseXMLAsync(`<resources>
  <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
    <item name="windowSplashScreenAnimatedIcon">@drawable/other</item>
  </style>
  <style name="Theme.App.SplashScreen" parent="Theme.SplashScreen">
    <item name="windowSplashScreenBackground">@color/splashscreen_background</item>
    <item name="windowSplashScreenAnimatedIcon">@drawable/splashscreen_logo</item>
  </style>
</resources>`);

  const [appTheme, splashTheme] =
    setSplashIconToLauncherIcon(styles).resources.style;

  assert.deepEqual(
    splashTheme.item.map((item) => item._),
    ['@color/splashscreen_background', '@mipmap/ic_launcher'],
  );
  assert.equal(appTheme.item[0]._, '@drawable/other');
});

test('gives the storyboard the splash background and no logo', async () => {
  const storyboard = await XML.parseXMLAsync(`<document>
  <scenes><scene><objects><viewController>
    <view id="EXPO-ContainerView">
      <subviews/>
      <constraints>
        <constraint firstItem="EXPO-SplashScreen" firstAttribute="centerY" secondItem="EXPO-ContainerView" id="a"/>
        <constraint firstItem="EXPO-SplashScreen" firstAttribute="centerX" secondItem="EXPO-ContainerView" id="b"/>
        <constraint firstItem="Other" firstAttribute="top" secondItem="EXPO-ContainerView" id="c"/>
      </constraints>
      <color key="backgroundColor" systemColor="systemBackgroundColor"/>
    </view>
  </viewController></objects></scene></scenes>
  <resources>
    <image name="SplashScreenLogo" width="100" height="90"/>
    <systemColor name="systemBackgroundColor"><color white="1" alpha="1"/></systemColor>
  </resources>
</document>`);

  const { document } = setStoryboardBackground(storyboard);
  const view = document.scenes[0].scene[0].objects[0].viewController[0].view[0];

  assert.deepEqual(view.color, [
    { $: { key: 'backgroundColor', name: 'SplashScreenBackground' } },
  ]);
  assert.deepEqual(
    view.constraints[0].constraint.map((constraint) => constraint.$.id),
    ['c'],
  );
  assert.deepEqual(Object.keys(document.resources[0]), ['namedColor']);
  assert.equal(
    document.resources[0].namedColor[0].$.name,
    'SplashScreenBackground',
  );
});
