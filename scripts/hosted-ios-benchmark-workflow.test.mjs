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
  assert.match(workflow, /inputs\.runner == 'macos-26'/);
  assert.match(workflow, /inputs\.runner == 'macos-26-intel'/);
  assert.match(workflow, /runs-on: \$\{\{ inputs\.runner \}\}/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(
    workflow,
    /cache_mode:[\s\S]*options:\n          - cold\n          - warm/,
  );
  assert.match(workflow, /cache_generation:[\s\S]*default: '1'/);
});

test('uses the pinned unsigned release toolchain', () => {
  assert.match(workflow, /XCODE_VERSION: '26\.6'/);
  assert.match(workflow, /XCODE_BUILD: 17F113/);
  assert.match(workflow, /COCOAPODS_VERSION: 1\.17\.0/);
  assert.match(workflow, /EXPO_PUBLIC_CHANGE_REMINDER_TEST_BUILD: 'true'/);
  assert.match(workflow, /version=\$\(pod --version\)/);
  assert.match(workflow, /test "\$version" = "\$COCOAPODS_VERSION"/);
  assert.doesNotMatch(workflow, /gem install/);
  assert.match(workflow, /expo prebuild --platform ios --clean --no-install/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /CODE_SIGNING_REQUIRED=NO/);
});

test('keeps cold and warm cache generations source-scoped and repeatable', () => {
  const cacheRevision = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
  const expectedCachePaths = `path: |
            \${{ runner.temp }}/ios-derived-data/Build/Intermediates.noindex/Pods.build
            \${{ runner.temp }}/ios-derived-data/ModuleCache.noindex`;
  const cachePathBlocks = [
    ...workflow.matchAll(
      /uses: actions\/cache\/(?:restore|save)@[^\n]+\n        with:\n          (path: \|\n(?:            [^\n]+\n)+)/g,
    ),
  ].map((match) => match[1].trimEnd());

  assert.equal(
    (workflow.match(/actions\/cache\/(?:restore|save)@/g) ?? []).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        new RegExp(`actions/cache/(?:restore|save)@${cacheRevision}`, 'g'),
      ) ?? []
    ).length,
    2,
  );
  assert.equal((workflow.match(/ModuleCache\.noindex/g) ?? []).length, 3);
  assert.equal(
    (workflow.match(/Build\/Intermediates\.noindex\/Pods\.build/g) ?? [])
      .length,
    3,
  );
  assert.deepEqual(cachePathBlocks, [expectedCachePaths, expectedCachePaths]);
  assert.match(workflow, /-derivedDataPath "\$RUNNER_TEMP\/ios-derived-data"/);
  assert.match(workflow, /RUNNER_ARCH/);
  assert.match(workflow, /GITHUB_SHA/);
  assert.match(workflow, /package_lock_hash/);
  assert.match(workflow, /pod_lock_hash/);
  assert.match(workflow, /inputs\.cache_generation/);
  assert.match(
    workflow,
    /CACHE_GENERATION: \$\{\{ inputs\.cache_generation \}\}/,
  );
  assert.match(workflow, /case "\$CACHE_GENERATION" in/);
  assert.match(
    workflow,
    /\$\{\{ steps\.cache-key\.outputs\.prefix \}\}-complete-/,
  );
  assert.match(
    workflow,
    /\$\{\{ steps\.cache-key\.outputs\.prefix \}\}-partial-/,
  );
  assert.match(workflow, /github\.run_id/);
  assert.match(workflow, /github\.run_attempt/);
  assert.match(workflow, /if: \$\{\{ inputs\.cache_mode == 'warm' \}\}/);
  assert.match(workflow, /Warm mode requires a matching cache generation/);
  assert.match(workflow, /origin='complete warm'/);
  assert.match(workflow, /origin='partial warm'/);
  assert.match(workflow, /cache_kib" -le 4194304/);
  assert.ok(
    workflow.indexOf('name: Record benchmark summary') <
      workflow.indexOf('name: Save allowlisted benchmark cache'),
  );
  assert.doesNotMatch(
    workflow,
    /secrets\.|id-token:|archivePath|\.ipa|keychain/i,
  );
});
