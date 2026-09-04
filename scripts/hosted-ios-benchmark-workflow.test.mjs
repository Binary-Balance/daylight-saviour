import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/hosted-ios-benchmark.yml', import.meta.url),
  'utf8',
);

test('limits the manual benchmark to the two standard hosted macOS runners', () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(
    workflow,
    /options:\n          - macos-26\n          - macos-26-intel/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.runner == 'macos-26' \|\| inputs\.runner == 'macos-26-intel' \}\}/,
  );
  assert.match(workflow, /runs-on: \$\{\{ inputs\.runner \}\}/);
  assert.match(workflow, /timeout-minutes: 30/);
});

test('uses the pinned unsigned release toolchain', () => {
  assert.match(workflow, /XCODE_VERSION: '26\.6'/);
  assert.match(workflow, /XCODE_BUILD: 17F113/);
  assert.match(workflow, /COCOAPODS_VERSION: 1\.17\.0/);
  assert.match(workflow, /EXPO_PUBLIC_CHANGE_REMINDER_TEST_BUILD: 'true'/);
  assert.match(workflow, /test "\$\(pod --version\)" = "\$COCOAPODS_VERSION"/);
  assert.doesNotMatch(workflow, /gem install/);
  assert.match(workflow, /expo prebuild --platform ios --clean --no-install/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /CODE_SIGNING_REQUIRED=NO/);
});

test('caches only bounded Xcode module data with a reviewed action revision', () => {
  const cacheRevision = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';

  assert.match(
    workflow,
    new RegExp(`actions/cache/(?:restore|save)@${cacheRevision}`, 'g'),
  );
  assert.equal(
    (workflow.match(/actions\/cache\/(?:restore|save)@/g) ?? []).length,
    2,
  );
  assert.equal((workflow.match(/ModuleCache\.noindex/g) ?? []).length, 3);
  assert.equal(
    (workflow.match(/Build\/Intermediates\.noindex\/Pods\.build/g) ?? [])
      .length,
    3,
  );
  assert.match(workflow, /-derivedDataPath "\$RUNNER_TEMP\/ios-derived-data"/);
  assert.match(workflow, /runner\.arch/);
  assert.match(workflow, /package_lock_hash/);
  assert.match(workflow, /pod_lock_hash/);
  assert.match(workflow, /github\.run_id/);
  assert.match(workflow, /cache_kib" -le 4194304/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|id-token:|archivePath|\.ipa|keychain/i,
  );
});
