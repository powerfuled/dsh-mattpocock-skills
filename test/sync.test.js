import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Config } from '../lib/index.js';
import { SkillStore } from '../lib/store.js';
import { SyncEngine } from '../lib/sync.js';
import { UpstreamClient } from '../lib/upstream.js';
import { SHA_A, SHA_B, SILENT_LOG, makeArchive, skillDoc, stubFetch } from './helpers.js';

const TDD_BODY = 'Use the [tests.md](tests.md) reference and call the Skill tool with "codebase-design".';

const MANIFEST = {
  name: 'mattpocock-skills',
  version: '1.3.1',
  license: 'MIT',
  repository: 'https://github.com/mattpocock/skills',
  skills: [
    './skills/engineering/tdd',
    './skills/engineering/codebase-design',
    './skills/engineering/not-a-skill',
    './skills/productivity/teach',
  ],
};

function repoFiles({ tddDescription = 'Test driven development.', includeTeach = true } = {}) {
  const files = {
    'skills/engineering/tdd/SKILL.md': skillDoc('tdd', tddDescription, TDD_BODY),
    'skills/engineering/tdd/tests.md': '# tests',
    'skills/engineering/codebase-design/SKILL.md': skillDoc('codebase-design', 'Design modules.'),
    'skills/engineering/not-a-skill/SKILL.md': '---\nname: Bad Name\ndescription: nope\n---\n',
    'skills/misc/hidden/SKILL.md': skillDoc('hidden', 'Not shipped upstream.'),
  };
  if (includeTeach) files['skills/productivity/teach/SKILL.md'] = skillDoc('teach', 'Teach a concept.');
  return files;
}

async function harness(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mps-sync-'));
  const current = {
    sha: SHA_A,
    archive: makeArchive(SHA_A, { manifest: MANIFEST, files: repoFiles() }),
  };
  const fetchImpl = stubFetch({
    sha: () => current.sha,
    archive: () => current.archive,
    fail: options.fail,
  });
  const config = {
    ...Config({ dataDir, autoSync: false, ...options.config }),
    fetchImpl,
  };
  const store = new SkillStore(config);
  const upstream = new UpstreamClient(config);
  const changes = [];
  const engine = new SyncEngine({
    config,
    store,
    upstream,
    log: SILENT_LOG,
    onChanged: (report) => changes.push(report),
  });
  return {
    dataDir,
    config,
    store,
    engine,
    changes,
    fetchImpl,
    publish(sha, files, manifest = MANIFEST) {
      current.sha = sha;
      current.archive = makeArchive(sha, { manifest, files: files ?? repoFiles() });
    },
  };
}

const codeloadCalls = (fetchImpl) => fetchImpl.calls.filter((url) => url.includes('codeload'));

test('mirrors the manifest skills and ignores everything else', async () => {
  const h = await harness();
  const report = await h.engine.sync({});

  assert.equal(report.error, null);
  assert.equal(report.updated, true);
  assert.equal(report.resolvedVia, 'api');
  assert.equal(report.latestSha, SHA_A);
  assert.deepEqual(report.added, ['codebase-design', 'tdd', 'teach']);
  assert.deepEqual(report.removed, []);
  assert.equal(report.skillCount, 3);
  assert.equal(report.upstreamVersion, '1.3.1');
  assert.deepEqual(
    report.invalid.map((entry) => entry.code),
    ['invalid-name'],
  );
  assert.equal(h.changes.length, 1);

  const state = await h.store.load();
  assert.equal(state.currentSha, SHA_A);
  assert.deepEqual(
    state.skills.map((skill) => skill.name),
    ['codebase-design', 'tdd', 'teach'],
  );
  assert.equal(state.skills.find((skill) => skill.name === 'tdd').category, 'engineering');

  const versionDir = h.store.versionDir(SHA_A);
  await access(join(versionDir, 'skills', 'engineering', 'tdd', 'SKILL.md'));
  await access(join(versionDir, 'skills', 'engineering', 'tdd', 'tests.md'));
  assert.equal(await h.store.hasVersion(SHA_A), true);
  const inventory = JSON.parse(await readFile(join(versionDir, 'inventory.json'), 'utf8'));
  assert.equal(inventory.sha, SHA_A);
  assert.equal(inventory.skills.length, 3);
});

test('re-checks an unchanged commit without downloading it again', async () => {
  const h = await harness();
  await h.engine.sync({});
  assert.equal(codeloadCalls(h.fetchImpl).length, 1);

  const second = await h.engine.sync({});
  assert.equal(second.upToDate, true);
  assert.equal(second.updated, false);
  assert.equal(second.error, null);
  assert.equal(codeloadCalls(h.fetchImpl).length, 1);
  assert.equal(h.changes.length, 1);
});

test('rolls forward, reporting added/removed/changed and keeping the previous version', async () => {
  const h = await harness();
  await h.engine.sync({});

  h.publish(SHA_B, repoFiles({ tddDescription: 'Test first, always.', includeTeach: false }));
  const report = await h.engine.sync({});

  assert.equal(report.previousSha, SHA_A);
  assert.equal(report.latestSha, SHA_B);
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.removed, ['teach']);
  assert.deepEqual(report.changed, ['tdd']);
  assert.equal(report.skillCount, 2);

  const state = await h.store.load();
  assert.equal(state.currentSha, SHA_B);
  assert.deepEqual((await readdir(h.store.versionsDir)).sort(), [SHA_A, SHA_B].sort());
  assert.equal(await h.store.hasVersion(SHA_A), true);
});

test('a dry run stages without switching the active version', async () => {
  const h = await harness();
  await h.engine.sync({});
  h.publish(SHA_B, repoFiles({ includeTeach: false }));

  const report = await h.engine.sync({ dryRun: true });
  assert.equal(report.staged, true);
  assert.equal(report.updated, false);
  assert.deepEqual(report.removed, ['teach']);

  const state = await h.store.load();
  assert.equal(state.currentSha, SHA_A);
  assert.deepEqual(
    state.skills.map((skill) => skill.name),
    ['codebase-design', 'tdd', 'teach'],
  );
  assert.equal(await h.store.hasVersion(SHA_B), true, 'the staged version stays cached for the next run');
});

test('falls back to the git advertisement when the API is rate limited', async () => {
  const h = await harness({
    fail: (url) => (url.includes('api.github.com') ? new Error('rate limited') : undefined),
  });
  const report = await h.engine.sync({});

  assert.equal(report.error, null);
  assert.equal(report.resolvedVia, 'info-refs');
  assert.equal(report.updated, true);
  assert.equal(report.skillCount, 3);
});

test('a failed first sync reports the error and leaves the catalog empty', async () => {
  const h = await harness({ fail: () => new Error('offline') });
  const report = await h.engine.sync({});

  assert.equal(report.updated, false);
  assert.equal(report.latestSha, null);
  assert.match(report.error, /offline/);
  assert.equal(h.store.state, null);
  assert.deepEqual(await h.engine.ensureLoaded({}), null);
});

test('a failed refresh keeps the last good mirror and records the error', async () => {
  let fail = false;
  const h = await harness({ fail: () => (fail ? new Error('offline') : undefined) });
  await h.engine.sync({});
  fail = true;

  const report = await h.engine.sync({});
  assert.match(report.error, /offline/);
  assert.equal(report.previousSha, SHA_A);

  const state = await h.store.load();
  assert.equal(state.currentSha, SHA_A);
  assert.match(state.lastError, /offline/);
  assert.equal(state.skills.length, 3);

  const recovered = await h.engine.ensureLoaded({});
  assert.equal(recovered.currentSha, SHA_A);
  assert.equal(codeloadCalls(h.fetchImpl).length, 1);
});

test('honours a category restriction', async () => {
  const h = await harness({ config: { categories: ['engineering'] } });
  const report = await h.engine.sync({});

  assert.deepEqual(report.added, ['codebase-design', 'tdd']);
  assert.equal(report.skillCount, 2);
});

test('discovers skill folders when the release manifest is absent', async () => {
  const h = await harness({ config: { useUpstreamManifest: false } });
  h.publish(SHA_A, repoFiles(), {});
  const report = await h.engine.sync({});

  assert.deepEqual(report.added, ['codebase-design', 'hidden', 'tdd', 'teach']);
  assert.deepEqual(
    (await h.store.load()).skills.map((skill) => skill.name),
    ['codebase-design', 'hidden', 'tdd', 'teach'],
  );
});

test('serializes concurrent syncs instead of racing them', async () => {
  const h = await harness();
  const [first, second] = await Promise.all([h.engine.sync({}), h.engine.sync({})]);
  assert.equal(first.updated, true);
  assert.equal(second.upToDate, true);
  assert.equal(codeloadCalls(h.fetchImpl).length, 1);
});
