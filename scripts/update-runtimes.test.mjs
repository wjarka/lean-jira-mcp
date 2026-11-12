import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, latestBunStable, latestNodeLts } from './update-runtimes.mjs';

test('selects the newest LTS even when current and prerelease versions are newer', () => {
  assert.equal(latestNodeLts([
    { version: 'v27.0.0', lts: false },
    { version: 'v28.0.0-rc.1', lts: 'Future' },
    { version: 'v26.9.0', lts: 'Lithium' },
    { version: 'v24.22.3', lts: 'Krypton' },
    { version: 'v26.13.1', lts: 'Lithium' },
  ]), '26.13.1');
});

test('fails rather than treating an empty LTS index as an update', () => {
  assert.throws(() => latestNodeLts([{ version: 'v27.0.0', lts: false }]));
});

test('accepts only stable published Bun releases', () => {
  assert.equal(latestBunStable({ tag_name: 'bun-v1.4.4', draft: false, prerelease: false }), '1.4.4');
  for (const release of [
    { tag_name: 'bun-v1.5.0', draft: true, prerelease: false },
    { tag_name: 'bun-v1.5.0', draft: false, prerelease: true },
    { tag_name: 'bun-v1.5.0-canary', draft: false, prerelease: false },
    {},
  ]) assert.throws(() => latestBunStable(release));
});

test('compares numerically so patches, new majors, and downgrades are distinguished', () => {
  assert.ok(compareVersions('26.13.1', '26.9.0') > 0);
  assert.ok(compareVersions('28.0.0', '26.13.1') > 0);
  assert.ok(compareVersions('1.4.3', '1.4.4') < 0);
  assert.equal(compareVersions('1.4.4', '1.4.4'), 0);
  assert.throws(() => compareVersions('latest', '1.4.4'));
});
