import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';

import { createTarGz, extractTarGz } from '../lib/tar.js';

/** Hand-built ustar header, used to exercise GNU/PAX extensions. */
function header(name, size, type) {
  const block = Buffer.alloc(512);
  Buffer.from(name, 'utf8').copy(block, 0, 0, 100);
  Buffer.from('0000644\0', 'utf8').copy(block, 100);
  Buffer.from('0000000\0', 'utf8').copy(block, 108);
  Buffer.from('0000000\0', 'utf8').copy(block, 116);
  Buffer.from(`${size.toString(8).padStart(11, '0')}\0`, 'utf8').copy(block, 124);
  Buffer.from(`${'1700000000'.padStart(11, '0')}\0`, 'utf8').copy(block, 136);
  Buffer.from('        ', 'utf8').copy(block, 148);
  block[156] = type.charCodeAt(0);
  Buffer.from('ustar\0', 'utf8').copy(block, 257);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'utf8').copy(block, 148);
  return block;
}

function pad(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const padding = (512 - (buffer.length % 512)) % 512;
  return [buffer, padding > 0 ? Buffer.alloc(padding) : Buffer.alloc(0)];
}

test('round-trips regular files and skips directories and symlinks', () => {
  const archive = createTarGz([
    { path: 'repo-abc/skills/tdd/SKILL.md', data: '# tdd' },
    { path: 'repo-abc/skills/tdd/tests.md', data: 'tests' },
    { path: 'repo-abc/skills/', type: '5', data: '' },
    { path: 'repo-abc/link', type: '2', data: '' },
  ]);

  const entries = extractTarGz(archive);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['repo-abc/skills/tdd/SKILL.md', 'repo-abc/skills/tdd/tests.md'],
  );
  assert.equal(entries[0].data.toString('utf8'), '# tdd');
});

test('honours stripComponents and filter', () => {
  const archive = createTarGz([
    { path: 'top/.claude-plugin/plugin.json', data: '{}' },
    { path: 'top/skills/a/SKILL.md', data: 'a' },
    { path: 'top/README.md', data: 'readme' },
  ]);

  const entries = extractTarGz(archive, {
    stripComponents: 1,
    filter: (path) => path === '.claude-plugin/plugin.json' || path.startsWith('skills/'),
  });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['.claude-plugin/plugin.json', 'skills/a/SKILL.md'],
  );
});

test('drops unsafe paths instead of escaping the target directory', () => {
  const archive = createTarGz([
    { path: '../escape.txt', data: 'nope' },
    { path: '/absolute.txt', data: 'nope' },
    { path: 'a/../../b.txt', data: 'nope' },
    { path: 'ok.txt', data: 'yes' },
  ]);

  const entries = extractTarGz(archive);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['ok.txt'],
  );
});

test('resolves GNU long names', () => {
  const longPath = `repo/${'nested/'.repeat(20)}deep.md`;
  const [longData, longPadding] = pad(longPath);
  const [content, contentPadding] = pad('content');
  const archive = gzipSync(
    Buffer.concat([
      header('longname', longData.length, 'L'),
      longData,
      longPadding,
      header('placeholder', content.length, '0'),
      content,
      contentPadding,
      Buffer.alloc(1024),
    ]),
  );

  const entries = extractTarGz(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, longPath);
  assert.equal(entries[0].data.toString('utf8'), 'content');
});

test('resolves PAX path headers', () => {
  const paxPath = `repo/${'pax/'.repeat(30)}file.md`;
  const body = `path=${paxPath}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const total = Buffer.byteLength(String(length)) + 1 + Buffer.byteLength(body);
    if (total === length) break;
    length = total;
  }
  const paxBody = `${length} ${body}`;
  const [paxData, paxPadding] = pad(paxBody);
  const [content, contentPadding] = pad('pax');
  const archive = gzipSync(
    Buffer.concat([
      header('PaxHeader', paxData.length, 'x'),
      paxData,
      paxPadding,
      header('placeholder', content.length, '0'),
      content,
      contentPadding,
      Buffer.alloc(1024),
    ]),
  );

  const entries = extractTarGz(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, paxPath);
});

test('rejects a truncated archive', () => {
  const archive = createTarGz([{ path: 'a.txt', data: 'hello' }]);
  const raw = gunzipSync(archive);
  assert.throws(() => extractTarGz(gzipSync(raw.subarray(0, 513))), /truncated archive/);
});

test('enforces the entry budget', () => {
  const archive = createTarGz([
    { path: 'a.txt', data: '1' },
    { path: 'b.txt', data: '2' },
    { path: 'c.txt', data: '3' },
  ]);
  assert.throws(() => extractTarGz(archive, { maxFiles: 2 }), /exceeds 2 entries/);
});
