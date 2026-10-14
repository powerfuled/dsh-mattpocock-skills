/**
 * End-to-end smoke test against the real upstream repository.
 *
 *   node scripts/smoke.mjs [--data-dir <path>] [--repo owner/name] [--ref main]
 *
 * Not part of `node --test`: it talks to github.com and needs network access.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '../lib/index.js';
import { MattpocockSkillProvider } from '../lib/provider.js';
import { SkillStore } from '../lib/store.js';
import { SyncEngine } from '../lib/sync.js';
import { UpstreamClient } from '../lib/upstream.js';

const here = fileURLToPath(new URL('..', import.meta.url));

function readArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [flag, inline] = token.slice(2).split('=');
    options[flag] = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
  }
  return options;
}

const args = readArgs(process.argv.slice(2));
const dataDir = resolve(args['data-dir'] ?? resolve(here, '.smoke'));
await mkdir(dataDir, { recursive: true });

const config = {
  ...Config({
    dataDir,
    autoSync: false,
    ...(args.repo === undefined ? {} : { repo: args.repo }),
    ...(args.ref === undefined ? {} : { ref: args.ref }),
  }),
};

const log = {
  debug: (...parts) => console.log('[debug]', ...parts),
  info: (...parts) => console.log('[info]', ...parts),
  warn: (...parts) => console.log('[warn]', ...parts),
  error: (...parts) => console.log('[error]', ...parts),
};

const store = new SkillStore(config);
const sync = new SyncEngine({
  config,
  store,
  upstream: new UpstreamClient(config),
  log,
  onChanged: () => {},
});

const report = await sync.sync({ force: args.force !== undefined });
console.log(
  JSON.stringify(
    {
      repo: report.repo,
      ref: report.ref,
      resolvedVia: report.resolvedVia,
      commit: report.latestSha,
      upstreamVersion: report.upstreamVersion,
      updated: report.updated,
      upToDate: report.upToDate,
      skillCount: report.skillCount,
      added: report.added.length,
      invalid: report.invalid,
      error: report.error,
    },
    null,
    2,
  ),
);
if (report.error !== null) process.exitCode = 1;

const provider = new MattpocockSkillProvider({ config, store, sync, log });
const { candidates, complete } = await provider.list({});
console.log(`\ncatalog: ${candidates.length} skills (complete=${complete})`);
for (const candidate of candidates) {
  console.log(`  ${candidate.name.padEnd(34)} ${candidate.description.slice(0, 60)}`);
}

const sample = candidates.find((candidate) => candidate.name === config.namePrefix + 'tdd') ?? candidates[0];
if (sample) {
  const definition = await provider.get(sample);
  console.log(`\nsample: ${sample.name} (${definition?.content?.length ?? 0} chars)`);
  console.log(`${(definition?.content ?? '').split('\n').slice(0, 6).join('\n')}`);
  console.log('resourceBase:', definition?.resourceBase?.path);
}

const second = await sync.sync({});
console.log(`\nsecond sync: upToDate=${second.upToDate} updated=${second.updated} error=${second.error}`);
