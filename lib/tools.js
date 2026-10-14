import { shortSha, uniqueStrings } from './util.js';

function line(parts) {
  return parts.filter((part) => part !== undefined && part !== null && part !== '').join(' ');
}

/** Shared status payload used by both tools. */
async function describe({ config, store }) {
  const state = await store.load();
  const skills = (state?.skills ?? []).map((skill) => ({
    id: `${config.namePrefix}${skill.name}`,
    name: skill.name,
    category: skill.category ?? null,
    enabled: store.isEnabled(skill.name, state),
    description: skill.description,
  }));
  return {
    repo: config.repo,
    ref: config.ref,
    commit: state?.currentSha ?? null,
    commitShort: state?.currentSha ? shortSha(state.currentSha) : null,
    upstreamVersion: state?.upstreamVersion ?? null,
    lastSyncAt: state?.lastSyncAt ?? null,
    lastCheckedAt: state?.lastCheckedAt ?? null,
    lastError: state?.lastError ?? null,
    namePrefix: config.namePrefix,
    autoSync: config.autoSync !== false,
    syncIntervalHours: config.syncIntervalHours,
    dataDir: store.dir,
    hasToken: config.token !== '',
    total: skills.length,
    enabledCount: skills.filter((skill) => skill.enabled).length,
    skills,
  };
}

function renderStatus(status, { withSkills = true } = {}) {
  const head = line([
    `Matt Pocock skills — ${status.repo}@${status.ref}`,
    status.commitShort ? `@${status.commitShort}` : '(not synced yet)',
    status.upstreamVersion ? `v${status.upstreamVersion}` : undefined,
  ]);
  const counts = `${status.enabledCount}/${status.total} enabled`;
  const sync = status.lastSyncAt ? `last sync ${status.lastSyncAt}` : 'never synced';
  const error = status.lastError ? `\nlast error: ${status.lastError}` : '';
  const list = withSkills
    ? status.skills
        .map(
          (skill) =>
            `  ${skill.enabled ? '[x]' : '[ ]'} ${skill.id}${skill.category ? ` (${skill.category})` : ''}`,
        )
        .join('\n')
    : '';
  return `${head}\n${counts} · ${sync}${error}${list ? `\n${list}` : ''}`;
}

function renderSyncReport(value) {
  if (!value) return 'Sync produced no result.';
  if (value.error) {
    return line([
      `Sync failed for ${value.repo}@${value.ref}.`,
      `Last active commit stays ${value.previousCommit ? shortSha(value.previousCommit) : 'unset'}.`,
      `Error: ${value.error}`,
    ]);
  }
  const headline = value.dryRun
    ? `Dry run: upstream is at ${value.commitShort ?? '(unknown)'}`
    : value.updated
      ? `Synced ${value.repo}@${value.ref} to ${value.commitShort ?? '(unknown)'}`
      : `Already up to date at ${value.commitShort ?? '(unknown)'}`;
  const parts = [headline];
  if (!value.dryRun && value.updated) parts.push(`${value.skillCount} skills (${value.enabledCount} enabled)`);
  else parts.push(`${value.skillCount} skills upstream`);
  parts.push(`+${value.added.length} -${value.removed.length} ~${value.changed.length}`);
  if (value.added.length > 0) parts.push(`added: ${value.added.join(', ')}`);
  if (value.removed.length > 0) parts.push(`removed: ${value.removed.join(', ')}`);
  if (value.changed.length > 0) parts.push(`changed: ${value.changed.join(', ')}`);
  if (value.invalid.length > 0) parts.push(`skipped: ${value.invalid.join('; ')}`);
  return parts.join('\n');
}

/**
 * Register the two management tools:
 * `sync_mattpocock_skills` (manual upstream sync) and
 * `manage_mattpocock_skills` (list / enable / disable individual skills).
 *
 * @returns {() => void} a disposer that unregisters every tool.
 */
export function registerTools({ ctx, config, store, sync, provider, log, notify }) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') return () => {};
  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: 'sync_mattpocock_skills',
      description:
        "Check the mirrored Matt Pocock agent skills (github.com/mattpocock/skills) against upstream and pull a new release when the tracked ref moved. Use when the user asks to update, refresh or check for new mp-* skills.",
      parameters: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Re-materialize the current commit even when the mirror already matches upstream.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'Download and stage the latest commit, report the added/removed/changed skills, but keep the current version active.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: renderSyncReport(value) }],
      },
      async execute(args = {}) {
        const report = await sync.sync({ force: args.force === true, dryRun: args.dryRun === true });
        const state = await store.load();
        const id = (skillName) => `${config.namePrefix}${skillName}`;
        return {
          ok: report.error === null,
          repo: report.repo,
          ref: report.ref,
          commit: report.latestSha,
          commitShort: report.latestSha ? shortSha(report.latestSha) : null,
          previousCommit: report.previousSha,
          resolvedVia: report.resolvedVia,
          upstreamVersion: report.upstreamVersion,
          updated: report.updated,
          upToDate: report.upToDate,
          dryRun: report.staged,
          skillCount: report.skillCount,
          enabledCount: (state?.skills ?? []).filter((skill) => store.isEnabled(skill.name, state)).length,
          added: report.added.map(id),
          removed: report.removed.map(id),
          changed: report.changed.map(id),
          invalid: report.invalid.map((entry) => entry.message),
          lastSyncAt: state?.lastSyncAt ?? null,
          error: report.error,
        };
      },
      presentCall(args = {}) {
        return {
          card: 'generic',
          title: args.dryRun ? 'Check Matt Pocock skills for updates' : 'Sync Matt Pocock skills',
          kind: 'execute',
          rawInput: `${config.repo}@${config.ref}`,
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'manage_mattpocock_skills',
      description:
        'List, enable or disable the individual mp-* skills mirrored from github.com/mattpocock/skills. Use when the user asks which mp-* skills exist, or wants specific ones turned on or off.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'status', 'enable', 'disable', 'enable_all', 'disable_all', 'reset'],
            description:
              'list/status show the catalog; enable/disable toggle the skills named in `skills`; enable_all/disable_all toggle everything; reset clears all manual overrides.',
          },
          skills: {
            type: 'array',
            items: { type: 'string' },
            description: 'Skill identifiers for enable/disable, with or without the name prefix (e.g. "tdd" or "mp-tdd").',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (args, value) => {
          if (!value || value.ok === false) {
            return [
              {
                type: 'text',
                text: line([
                  'Skill management failed.',
                  value?.unknown?.length ? `Unknown skills: ${value.unknown.join(', ')}` : undefined,
                  value?.error,
                ]),
              },
            ];
          }
          const action = String(args?.action ?? 'status');
          if (action === 'list' || action === 'status') return [{ type: 'text', text: renderStatus(value) }];
          return [
            {
              type: 'text',
              text: line([
                `Applied "${action}".`,
                value.changed?.length ? `Changed: ${value.changed.join(', ')}` : 'No changes.',
                `${value.enabledCount}/${value.total} enabled.`,
              ]),
            },
          ];
        },
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'status');
        const state = await store.load();
        const known = new Map();
        for (const skill of state?.skills ?? []) {
          known.set(skill.name, skill.name);
          known.set(`${config.namePrefix}${skill.name}`, skill.name);
        }

        const requested = uniqueStrings(args.skills);
        const resolved = [];
        const unknown = [];
        for (const raw of requested) {
          const hit = known.get(raw);
          if (hit === undefined) unknown.push(raw);
          else if (!resolved.includes(hit)) resolved.push(hit);
        }

        const allNames = (state?.skills ?? []).map((skill) => skill.name);
        const id = (skillName) => `${config.namePrefix}${skillName}`;
        const invalidate =
          typeof notify === 'function' ? notify : () => provider.invalidate();

        if (action === 'enable' || action === 'disable') {
          if (requested.length === 0) {
            return { ok: false, action, error: 'the enable/disable actions require the `skills` list', unknown: [] };
          }
          if (unknown.length > 0) {
            return { ok: false, action, error: 'unknown skill identifiers', unknown, changed: [] };
          }
          const before = (state?.skills ?? []).filter((skill) => store.isEnabled(skill.name, state));
          const enabled = action === 'enable';
          for (const name of resolved) await store.setOverride(name, enabled);
          const after = await store.load();
          invalidate();
          const changed = resolved
            .filter((name) => {
              const wasOn = before.some((skill) => skill.name === name);
              const isOn = store.isEnabled(name, after);
              return wasOn !== isOn;
            })
            .map(id);
          log.info(`manage: ${action} ${resolved.join(', ')}`);
          return { ok: true, action, changed, unknown: [], ...(await describe({ config, store })) };
        }

        if (action === 'enable_all' || action === 'disable_all') {
          const enabled = action === 'enable_all';
          const before = new Set(
            (state?.skills ?? [])
              .filter((skill) => store.isEnabled(skill.name, state))
              .map((skill) => skill.name),
          );
          for (const name of allNames) await store.setOverride(name, enabled);
          invalidate();
          const changed = allNames.filter((name) => before.has(name) !== enabled).map(id);
          log.info(`manage: ${action} (${allNames.length} skills)`);
          return { ok: true, action, changed, unknown: [], ...(await describe({ config, store })) };
        }

        if (action === 'reset') {
          await store.clearOverrides();
          await store.load({ force: true });
          invalidate();
          log.info('manage: reset overrides');
          return { ok: true, action, changed: [], unknown: [], ...(await describe({ config, store })) };
        }

        return { ok: true, action, changed: [], unknown: [], ...(await describe({ config, store })) };
      },
      presentCall(args = {}) {
        return {
          card: 'generic',
          title: `Manage Matt Pocock skills (${args?.action ?? 'list'})`,
          kind: 'edit',
          rawInput: Array.isArray(args?.skills) ? args.skills.join(', ') : undefined,
        };
      },
    }),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        log.warn(`cannot unregister tool: ${error?.message ?? error}`);
      }
    }
  };
}
