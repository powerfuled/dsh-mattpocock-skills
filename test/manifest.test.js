import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontmatter, readStringField } from '../lib/frontmatter.js';
import { buildSkillRecord, deriveCategory, parseUpstreamManifest } from '../lib/manifest.js';

test('splits YAML frontmatter from the body', () => {
  const parsed = parseFrontmatter('---\nname: tdd\ndescription: Test driven.\n---\n\n# Body\n');
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.data.name, 'tdd');
  assert.equal(parsed.body, '# Body');
});

test('treats a document without frontmatter as pure body', () => {
  const parsed = parseFrontmatter('# Just markdown\n');
  assert.equal(parsed.hasFrontmatter, false);
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, '# Just markdown');
});

test('reports malformed frontmatter instead of throwing', () => {
  const parsed = parseFrontmatter('---\nname: [unclosed\n---\nbody');
  assert.equal(typeof parsed.error, 'string');
});

test('readStringField ignores blank values and stringifies scalars', () => {
  assert.equal(readStringField({ a: '  ', b: 'x' }, 'a', 'b'), 'x');
  assert.equal(readStringField({ a: 7 }, 'a'), '7');
  assert.equal(readStringField({}, 'a'), undefined);
});

test('reads only the skills listed by the release manifest', () => {
  const manifest = parseUpstreamManifest({
    name: 'mattpocock-skills',
    version: '1.3.1',
    license: 'MIT',
    repository: { url: 'https://github.com/mattpocock/skills' },
    author: { name: 'Matt Pocock' },
    skills: ['./skills/engineering/tdd', 'skills/productivity/teach/', './skills/engineering/tdd', 42, ''],
  });

  assert.deepEqual(manifest.skills, ['skills/engineering/tdd', 'skills/productivity/teach']);
  assert.equal(manifest.version, '1.3.1');
  assert.equal(manifest.repository, 'https://github.com/mattpocock/skills');
  assert.equal(manifest.author, 'Matt Pocock');
});

test('derives categories from the path below the skills root', () => {
  assert.equal(deriveCategory('skills/engineering/tdd'), 'engineering');
  assert.equal(deriveCategory('skills/top-level'), 'general');
});

test('builds a record, keeping the declared name and sidecar frontmatter', () => {
  const built = buildSkillRecord({
    skillPath: 'skills/engineering/tdd',
    docText: '---\nname: tdd\ndescription: Test driven.\nwhenToUse: red-green-refactor\nallowed-tools: Read\n---\nbody',
  });

  assert.equal(built.ok, true);
  assert.equal(built.record.name, 'tdd');
  assert.equal(built.record.category, 'engineering');
  assert.equal(built.record.description, 'Test driven.');
  assert.equal(built.record.whenToUse, 'red-green-refactor');
  assert.deepEqual(built.record.frontmatter, {
    whenToUse: 'red-green-refactor',
    'allowed-tools': 'Read',
  });
});

test('maps upstream invocation flags onto the DSH invocation policy', () => {
  const userDriven = buildSkillRecord({
    skillPath: 'skills/engineering/implement',
    docText: '---\nname: implement\ndescription: Ship it.\ndisable-model-invocation: true\n---\nbody',
  });
  assert.deepEqual(userDriven.record.invocation, { modelInvocable: false, userInvocable: true });

  const hidden = buildSkillRecord({
    skillPath: 'skills/x/secret',
    docText: '---\nname: secret\ndescription: Hidden.\nuser-invocable: false\n---\nbody',
  });
  assert.deepEqual(hidden.record.invocation, { modelInvocable: true, userInvocable: false });

  const plain = buildSkillRecord({
    skillPath: 'skills/x/plain',
    docText: '---\nname: plain\ndescription: Plain.\n---\nbody',
  });
  assert.deepEqual(plain.record.invocation, { modelInvocable: true, userInvocable: true });
});

test('falls back to the directory name when the frontmatter omits name', () => {
  const built = buildSkillRecord({
    skillPath: 'skills/engineering/wayfinder',
    docText: '---\ndescription: Find the way.\n---\nbody',
  });
  assert.equal(built.ok, true);
  assert.equal(built.record.name, 'wayfinder');
  assert.equal(built.record.declaredName, undefined);
});

test('rejects invalid, reserved and undescribed skills', () => {
  const bad = buildSkillRecord({
    skillPath: 'skills/x/Bad Name',
    docText: '---\nname: Bad Name\ndescription: nope\n---\n',
  });
  assert.deepEqual({ ok: bad.ok, code: bad.code }, { ok: false, code: 'invalid-name' });

  const reserved = buildSkillRecord({
    skillPath: 'skills/x/con',
    docText: '---\nname: con\ndescription: nope\n---\n',
  });
  assert.deepEqual({ ok: reserved.ok, code: reserved.code }, { ok: false, code: 'reserved-name' });

  const missing = buildSkillRecord({
    skillPath: 'skills/x/nodef',
    docText: '---\nname: nodef\n---\n',
  });
  assert.deepEqual({ ok: missing.ok, code: missing.code }, { ok: false, code: 'missing-description' });
});
