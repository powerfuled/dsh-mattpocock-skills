import z from '@deepseek-ai/schemastery';

import { MattpocockSkillProvider, PROVIDER_NAME } from './provider.js';
import { SkillStore } from './store.js';
import { SyncEngine } from './sync.js';
import { UpstreamClient } from './upstream.js';
import { makeLogger } from './util.js';
import { registerTools } from './tools.js';

export { MattpocockSkillProvider, PROVIDER_NAME } from './provider.js';
export { SkillStore } from './store.js';
export { SyncEngine } from './sync.js';
export { UpstreamClient } from './upstream.js';

/** Cordis plugin name (the loader entry id is separate and lives in cordis.patch.yml). */
export const name = 'mattpocock-skills';

/** Host services this plugin attaches to. */
export const inject = ['skills', 'tools'];

/**
 * Plugin configuration. Every field below can be overridden from
 * `~/.dsh/profiles/<profile>/cordis.patch.yml` on the plugin's own entry.
 */
export const Config = z.object({
  /** Upstream GitHub repository, `owner/name`. */
  repo: z.string().default('mattpocock/skills'),
  /** Branch, tag or commit sha to mirror. */
  ref: z.string().default('main'),
  /** Optional GitHub token; raises the API rate limit and allows private mirrors. */
  token: z.string().default(''),
  /** Release manifest inside the repository that lists the shipped skills. */
  manifestPath: z.string().default('.claude-plugin/plugin.json'),
  /** Directory that holds the skill folders. */
  skillsRoot: z.string().default('skills'),
  /** Only expose skills listed by the release manifest (ignore in-progress/misc/deprecated). */
  useUpstreamManifest: z.boolean().default(true),
  /** Restrict to these categories, e.g. ["engineering"]; empty means every category. */
  categories: z.array(z.string()).default([]),
  /** Prefix applied to every skill name so upstream names never collide. */
  namePrefix: z.string().default('mp-'),
  /** Provider precedence; lower wins. 700 keeps mirrored skills below bundled (600) and filesystem (100-500) skills, so a local skill always wins a tie. */
  rank: z.number().default(700),
  /** Skill source label shown in the catalog. */
  source: z.string().default('custom'),
  /** Rename upstream skill-to-skill references so prefixed names resolve. */
  rewriteSkillReferences: z.boolean().default(true),
  /** Honour upstream `disable-model-invocation` / `user-invocable` frontmatter flags. */
  honourInvocationFlags: z.boolean().default(true),
  /** Initial enablement for skills without an explicit runtime override. */
  defaultEnabled: z.boolean().default(true),
  /** Allow-list applied when `defaultEnabled` is false. */
  enabledSkills: z.array(z.string()).default([]),
  /** Deny-list applied after the allow-list. */
  disabledSkills: z.array(z.string()).default([]),
  /** Mirror upstream once during startup when nothing has been mirrored yet. */
  syncOnStart: z.boolean().default(true),
  /** Keep the mirror fresh automatically in the background. */
  autoSync: z.boolean().default(true),
  /** Delay before the first background sync. */
  initialSyncDelaySeconds: z.number().default(10),
  /** Background sync cadence. */
  syncIntervalHours: z.number().default(24),
  /** How many mirrored commits to retain for instant rollback. */
  keepVersions: z.number().default(3),
  /** Hard cap on the downloaded archive size. */
  maxArchiveBytes: z.number().default(32 * 1024 * 1024),
  /** Per-request network timeout. */
  timeoutMs: z.number().default(30000),
  /** Mirror location; empty means `<DSH_HOME>/plugin-data/dsh-mattpocock-skills`. */
  dataDir: z.string().default(''),
  /** Register the `sync_mattpocock_skills` / `manage_mattpocock_skills` tools. */
  registerTools: z.boolean().default(true),
});

/** Resolve defaults even when the loader calls `apply` with a raw object. */
function resolveConfig(config) {
  try {
    return { ...Config(config ?? {}) };
  } catch {
    return { ...(config ?? {}) };
  }
}

/** Emit a host event without letting a missing listener break the sync. */
function safeEmit(ctx, event) {
  try {
    ctx?.emit?.(event);
  } catch {
    /* the event is advisory */
  }
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const log = makeLogger(ctx, 'dsh-mattpocock-skills');
  const store = new SkillStore(cfg);
  const upstream = new UpstreamClient(cfg);
  const provider = new MattpocockSkillProvider({ config: cfg, store, log });
  const sync = new SyncEngine({
    config: cfg,
    store,
    upstream,
    log,
    onChanged: () => {
      provider.invalidate();
      safeEmit(ctx, 'commands/change');
    },
  });
  provider.bindSync(sync);

  ctx.effect(
    () =>
      ctx.skills.registerProvider((control) => {
        provider.attach(control);
        return provider;
      }),
    'mattpocock-skills provider',
  );

  if (cfg.registerTools !== false) {
    ctx.effect(
      () =>
        registerTools({
          ctx,
          config: cfg,
          store,
          sync,
          provider,
          log,
          notify: () => {
            provider.invalidate();
            safeEmit(ctx, 'commands/change');
          },
        }),
      'mattpocock-skills tools',
    );
  }

  ctx.effect(() => {
    sync.start();
    return () => sync.stop();
  }, 'mattpocock-skills auto sync');

  log.info(
    `ready (repo=${cfg.repo} ref=${cfg.ref} prefix="${cfg.namePrefix}" autoSync=${cfg.autoSync !== false ? `${cfg.syncIntervalHours}h` : 'off'})`,
  );
}
