import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Config, MattpocockSkillProvider, apply, inject, name } from '../lib/index.js';
import { SkillStore } from '../lib/store.js';
import { createFakeContext, skillDoc } from './helpers.js';

const SHA = 'f'.repeat(40);
const TDD_BODY =
  'Follow [tests.md](tests.md), call the Skill tool with "codebase-design", ' +
  'revisit the `codebase-design` skill, and say "hello".';

const SKILLS = [
  {
    name: 'tdd',
    description: 'Test driven development.',
    category: 'engineering',
    path: 'skills/engineering/tdd',
  },
  {
    name: 'codebase-design',
    description: 'Design modules.',
    category: 'engineering',
    path: 'skills/engineering/codebase-design',
  },
];

/** Build an on-disk mirror that looks exactly like a finished sync. */
async function seedMirror(overrides = {}, skills = SKILLS) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mps-plugin-'));
  for (const skill of skills) {
    const dir = join(dataDir, 'versions', SHA, skill.path);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      skillDoc(skill.name, skill.description, skill.name === 'tdd' ? TDD_BODY : 'body'),
    );
  }
  await writeFile(join(dataDir, 'versions', SHA, 'skills', 'engineering', 'tdd', 'tests.md'), '# tests');

  const config = { ...Config({ dataDir, autoSync: false, syncOnStart: false, ...overrides }) };
  const store = new SkillStore(config);
  await store.save({ currentSha: SHA, upstreamVersion: '1.3.1', skills });
  return { dataDir, config, store };
}

test('exposes the plugin metadata the loader needs', () => {
  assert.equal(name, 'mattpocock-skills');
  assert.deepEqual(inject, ['skills', 'tools']);
  assert.equal(Config({}).namePrefix, 'mp-');
  assert.equal(Config({}).rank, 700);
  assert.equal(Config({}).repo, 'mattpocock/skills');
  // Unknown keys survive resolution, so host-side extras (e.g. a test fetch) can ride along.
  assert.equal(Config({ unrelated: 'kept' }).unrelated, 'kept');
});

test('registers the provider, the tools and the sync lifecycle', async () => {
  const { config } = await seedMirror();
  const ctx = createFakeContext();
  apply(ctx, config);

  assert.equal(ctx.providers.length, 1);
  assert.equal(ctx.providers[0].name, 'mattpocock-skills');
  assert.deepEqual(
    ctx.effects.map((entry) => entry.label),
    ['mattpocock-skills provider', 'mattpocock-skills tools', 'mattpocock-skills auto sync'],
  );
  assert.deepEqual(
    [...ctx.registeredTools.keys()].sort(),
    ['manage_mattpocock_skills', 'sync_mattpocock_skills'],
  );

  const definition = ctx.registeredTools.get('sync_mattpocock_skills');
  assert.deepEqual(definition.parameters.properties.force.type, 'boolean');
  assert.deepEqual(definition.presentCall({}).kind, 'execute');
  const rendered = definition.output.render(
    {},
    {
      ok: true,
      repo: 'mattpocock/skills',
      ref: 'main',
      commitShort: 'abc1234',
      updated: true,
      dryRun: false,
      skillCount: 3,
      enabledCount: 2,
      added: ['tdd'],
      removed: [],
      changed: [],
      invalid: [],
    },
  );
  assert.match(rendered[0].text, /abc1234/);
  assert.match(rendered[0].text, /3 skills/);
});

test('lists prefixed candidates from the mirror and rewrites skill references', async () => {
  const { config } = await seedMirror();
  const ctx = createFakeContext();
  apply(ctx, config);
  const provider = ctx.providers[0];

  const candidates = (await provider.list({})).candidates;
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ['mp-tdd', 'mp-codebase-design'],
  );
  assert.equal(candidates[0].rank, 700);
  assert.equal(candidates[0].source, 'custom');
  assert.equal(candidates[0].provider, 'mattpocock-skills');
  assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true });
  assert.ok(candidates[0].resourceBase.path.endsWith(join('skills', 'engineering', 'tdd')));
  assert.equal(candidates[0].metadata.mattpocockSkills.upstreamVersion, '1.3.1');

  const definition = await provider.get(candidates[0]);
  assert.equal(definition.name, 'mp-tdd');
  assert.equal(definition.provider, 'mattpocock-skills');
  assert.match(definition.content, /"mp-codebase-design"/);
  assert.match(definition.content, /`mp-codebase-design`/, 'backticked references are rewritten too');
  assert.match(definition.content, /"hello"/, 'unrelated quoted words are left alone');
  assert.match(definition.content, /\[tests\.md\]\(tests\.md\)/, 'sibling links stay relative');
  assert.equal(await provider.get({ name: 'mp-tdd' }), undefined, 'a candidate without a locator is rejected');
});

test('serves an existing mirror without a sync engine or a logger', async () => {
  const { config, store } = await seedMirror();
  const provider = new MattpocockSkillProvider({ config, store });

  const { candidates, complete } = await provider.list({});
  assert.equal(complete, true, 'a missing sync engine must not turn discovery into a failure');
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ['mp-tdd', 'mp-codebase-design'],
  );
  const definition = await provider.get(candidates[0]);
  assert.match(definition.content, /"mp-codebase-design"/);
});

test('honours a custom name prefix and lets it be disabled', async () => {
  const { config } = await seedMirror({ namePrefix: '' });
  const ctx = createFakeContext();
  apply(ctx, config);
  const candidates = (await ctx.providers[0].list({})).candidates;
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ['tdd', 'codebase-design'],
  );
  const definition = await ctx.providers[0].get(candidates[0]);
  assert.match(definition.content, /"codebase-design"/);
});

test('honours upstream invocation flags, and can be configured to ignore them', async () => {
  const flagged = [
    { ...SKILLS[0], invocation: { modelInvocable: false, userInvocable: true } },
    SKILLS[1],
  ];

  const on = await seedMirror({}, flagged);
  const onCtx = createFakeContext();
  apply(onCtx, on.config);
  const onCandidates = (await onCtx.providers[0].list({})).candidates;
  assert.deepEqual(
    onCandidates[0].invocation,
    { modelInvocable: false, userInvocable: true },
    'a user-driven upstream skill stays out of the model catalog',
  );
  assert.deepEqual(
    onCandidates[1].invocation,
    { modelInvocable: true, userInvocable: true },
    'a skill without the upstream flag stays model-invocable',
  );

  const off = await seedMirror({ honourInvocationFlags: false }, flagged);
  const offCtx = createFakeContext();
  apply(offCtx, off.config);
  const offCandidates = (await offCtx.providers[0].list({})).candidates;
  assert.deepEqual(offCandidates[0].invocation, { modelInvocable: true, userInvocable: true });
});

test('toggles skills through the management tool and invalidates the catalog', async () => {
  const { config, store } = await seedMirror();
  const ctx = createFakeContext();
  apply(ctx, config);
  const manage = ctx.registeredTools.get('manage_mattpocock_skills');

  const before = await manage.execute({ action: 'list' });
  assert.equal(before.total, 2);
  assert.equal(before.enabledCount, 2);
  assert.deepEqual(
    before.skills.map((skill) => skill.id),
    ['mp-tdd', 'mp-codebase-design'],
  );

  const disabled = await manage.execute({ action: 'disable', skills: ['mp-tdd'] });
  assert.equal(disabled.ok, true);
  assert.deepEqual(disabled.changed, ['mp-tdd']);
  assert.equal(disabled.enabledCount, 1);
  assert.equal(ctx.invalidations.length, 1, 'disabling refreshes the live catalog');
  assert.equal(ctx.events.at(-1), 'commands/change');

  const persisted = await store.load({ force: true });
  assert.deepEqual(persisted.overrides, { tdd: false });
  assert.equal(store.isEnabled('tdd'), false);

  const listed = await manage.execute({ action: 'list' });
  assert.deepEqual(
    listed.skills.map((skill) => skill.id),
    ['mp-tdd', 'mp-codebase-design'],
  );
  assert.deepEqual(
    listed.skills.filter((skill) => skill.enabled).map((skill) => skill.id),
    ['mp-codebase-design'],
  );

  const restored = await manage.execute({ action: 'enable', skills: ['tdd'] });
  assert.deepEqual(restored.changed, ['mp-tdd']);
  assert.equal(restored.enabledCount, 2);
});

test('rejects unknown skills and requires a target list', async () => {
  const { config } = await seedMirror();
  const ctx = createFakeContext();
  apply(ctx, config);
  const manage = ctx.registeredTools.get('manage_mattpocock_skills');

  const unknown = await manage.execute({ action: 'disable', skills: ['mp-nope'] });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.unknown, ['mp-nope']);

  const missing = await manage.execute({ action: 'enable' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /skills/);
});

test('bulk actions and reset work as advertised', async () => {
  const { config, store } = await seedMirror();
  const ctx = createFakeContext();
  apply(ctx, config);
  const manage = ctx.registeredTools.get('manage_mattpocock_skills');

  const off = await manage.execute({ action: 'disable_all' });
  assert.deepEqual(off.changed.sort(), ['mp-codebase-design', 'mp-tdd']);
  assert.equal(off.enabledCount, 0);

  const on = await manage.execute({ action: 'enable_all' });
  assert.deepEqual(on.changed.sort(), ['mp-codebase-design', 'mp-tdd']);
  assert.equal(on.enabledCount, 2);

  const reset = await manage.execute({ action: 'reset' });
  assert.deepEqual(reset.changed, []);
  assert.deepEqual((await store.load({ force: true })).overrides, {});
});
