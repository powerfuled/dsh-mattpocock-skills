import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Config } from '../lib/index.js';
import { SkillStore } from '../lib/store.js';

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mps-store-'));
  const config = { ...Config({ dataDir: dir, ...overrides }) };
  return { dir, config, store: new SkillStore(config) };
}

test('defaults to enabled and applies the static lists', async () => {
  const { config } = await makeStore();

  const plain = new SkillStore({ ...config, defaultEnabled: true });
  assert.equal(plain.isEnabled('anything', null), true);

  const listed = new SkillStore({ ...config, disabledSkills: ['blocked'], enabledSkills: ['allowed'] });
  assert.equal(listed.isEnabled('allowed', null), true);
  assert.equal(listed.isEnabled('blocked', null), false);
  assert.equal(listed.isEnabled('anything', null), false, 'a non-empty allow-list restricts the catalog');

  const strict = new SkillStore({ ...config, defaultEnabled: false, enabledSkills: ['allowed'] });
  assert.equal(strict.isEnabled('allowed', null), true);
  assert.equal(strict.isEnabled('other', null), false);
});

test('runtime overrides beat the static configuration and persist', async () => {
  const { dir, config, store } = await makeStore({ disabledSkills: ['tdd'] });
  assert.equal(store.isEnabled('tdd', null), false);

  await store.setOverride('tdd', true);
  assert.equal(store.isEnabled('tdd'), true);

  const reloaded = new SkillStore(config);
  await reloaded.load();
  assert.equal(reloaded.isEnabled('tdd'), true);

  await reloaded.clearOverrides();
  assert.equal(reloaded.isEnabled('tdd'), false);

  const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.overrides, {});
});

test('prunes old versions but keeps the current one and the newest backups', async () => {
  const { store } = await makeStore();
  await mkdir(store.versionsDir, { recursive: true });
  for (const [index, sha] of ['1', '2', '3', '4', '5'].entries()) {
    await mkdir(join(store.versionsDir, sha), { recursive: true });
    await writeFile(join(store.versionsDir, sha, 'marker'), sha);
    const when = new Date(Date.UTC(2025, 0, index + 1));
    await utimes(join(store.versionsDir, sha), when, when);
  }
  await mkdir(join(store.versionsDir, 'old.staging-1-2'), { recursive: true });
  await store.save({ currentSha: '3', skills: [] });

  const removed = await store.pruneVersions(2);
  assert.deepEqual(removed.sort(), ['1', '2']);
  assert.deepEqual((await readdir(store.versionsDir)).sort(), ['3', '4', '5']);
});

test('skillDir refuses to escape the version directory', async () => {
  const { store } = await makeStore();
  assert.ok(store.skillDir('abc', 'skills/tdd').endsWith(join('abc', 'skills', 'tdd')));
  assert.equal(store.skillDir('abc', '../../etc'), undefined);
});
