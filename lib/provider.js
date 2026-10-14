import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter } from './frontmatter.js';
import { isSkillName, shortSha } from './util.js';

export const PROVIDER_NAME = 'mattpocock-skills';

/**
 * Rewrite quoted skill references (`"name"`, `'name'`, `` `name` ``) so that a skill whose own
 * text names another skill by its upstream name still resolves once every name carries the prefix.
 * Only names present in the mirror are touched, so ordinary prose is left alone.
 */
function rewriteSkillReferences(content, prefix, known) {
  if (prefix === '' || known.size === 0) return content;
  return content.replace(
    /(["'`])([a-z0-9][a-z0-9-]*)\1/g,
    (match, quote, name) => (known.has(name) ? `${quote}${prefix}${name}${quote}` : match),
  );
}

/**
 * Exposes the mirrored upstream skills as DSH skills.
 *
 * Discovery is local: it reads the on-disk mirror and never downloads. Only the
 * very first lookup, on an installation that has never mirrored anything, fills
 * the mirror (and only when `syncOnStart` is enabled).
 */
export class MattpocockSkillProvider {
  #config;
  #store;
  #sync;
  #log;
  #invalidate = () => {};

  constructor({ config, store, sync, log }) {
    this.name = PROVIDER_NAME;
    this.#config = config;
    this.#store = store;
    this.#sync = sync;
    // The entry point always supplies a logger; a standalone construction must not be able to
    // turn a recoverable discovery failure into a TypeError inside the catch block.
    this.#log = log ?? { info() {}, warn() {}, debug() {} };
  }

  /** Bind the registry's registration-scoped invalidation callback. */
  attach(control) {
    if (control && typeof control.invalidate === 'function') this.#invalidate = control.invalidate;
  }

  /**
   * Late-bind the sync engine. The engine's `onChanged` hook calls back into
   * `invalidate()`, so the two objects are wired after both exist.
   */
  bindSync(sync) {
    this.#sync = sync;
  }

  /** Ask the registry to rebuild its catalogs. */
  invalidate() {
    try {
      this.#invalidate();
    } catch (error) {
      this.#log.warn(`catalog invalidation failed: ${error?.message ?? error}`);
    }
  }

  /** Namespaced skill name for one upstream skill. */
  skillName(upstreamName) {
    return `${this.#config.namePrefix}${upstreamName}`;
  }

  /**
   * Invocation policy for one mirrored skill. Upstream marks 16 of its 27 skills as
   * user-driven (`disable-model-invocation: true`), so the model only auto-loads the rest;
   * `honourInvocationFlags: false` exposes everything to the model.
   */
  #invocation(recorded) {
    if (this.#config.honourInvocationFlags === false) return { modelInvocable: true, userInvocable: true };
    if (!recorded || typeof recorded !== 'object') return { modelInvocable: true, userInvocable: true };
    return {
      modelInvocable: recorded.modelInvocable !== false,
      userInvocable: recorded.userInvocable !== false,
    };
  }

  async list(options = {}) {
    try {
      // With no sync engine attached this is a read-only provider: serve whatever the mirror holds.
      const state = this.#sync
        ? await this.#sync.ensureLoaded({ signal: options?.signal })
        : await this.#store.load();
      const sha = state?.currentSha;
      if (typeof sha !== 'string' || sha === '') return { candidates: [], complete: true };

      const candidates = [];
      for (const skill of state.skills ?? []) {
        if (!this.#store.isEnabled(skill.name, state)) continue;
        const skillName = this.skillName(skill.name);
        if (!isSkillName(skillName)) {
          this.#log.warn(`skipping "${skill.name}": "${skillName}" is not a valid skill name`);
          continue;
        }
        const directory = this.#store.skillDir(sha, skill.path);
        if (directory === undefined) {
          this.#log.warn(`skipping "${skill.name}": unsafe mirror path "${skill.path}"`);
          continue;
        }
        const candidate = {
          name: skillName,
          description: skill.description,
          invocation: this.#invocation(skill.invocation),
          source: this.#config.source,
          provider: this.name,
          rank: this.#config.rank,
          path: join(directory, 'SKILL.md'),
          resourceBase: { kind: 'directory', path: directory },
          locator: { sha, name: skill.name, path: skill.path },
          metadata: {
            mattpocockSkills: {
              repo: this.#config.repo,
              ref: this.#config.ref,
              sha,
              upstreamVersion: state.upstreamVersion ?? null,
              upstreamName: skill.name,
              upstreamPath: skill.path,
              category: skill.category ?? null,
              frontmatter: skill.frontmatter ?? {},
            },
          },
        };
        if (typeof skill.whenToUse === 'string') candidate.whenToUse = skill.whenToUse;
        candidates.push(candidate);
      }
      return { candidates, complete: true };
    } catch (error) {
      this.#log.warn(`skill discovery failed: ${error?.message ?? error}`);
      return { candidates: [], complete: false };
    }
  }

  async get(candidate, options = {}) {
    const locator = candidate?.locator;
    if (!locator || typeof locator !== 'object') return undefined;
    const { sha, name, path } = locator;
    if (typeof sha !== 'string' || typeof name !== 'string' || typeof path !== 'string') return undefined;

    const state = await this.#store.load();
    if (state?.currentSha !== sha) return undefined;
    if (!this.#store.isEnabled(name, state)) return undefined;

    const directory = this.#store.skillDir(sha, path);
    if (directory === undefined) return undefined;
    const docPath = join(directory, 'SKILL.md');

    let text;
    try {
      text = await readFile(docPath, 'utf8');
    } catch (error) {
      this.#log.warn(`cannot read ${docPath}: ${error?.message ?? error}`);
      return undefined;
    }

    const parsed = parseFrontmatter(text);
    const known = new Set((state.skills ?? []).map((skill) => skill.name));
    const content =
      this.#config.rewriteSkillReferences === false
        ? parsed.body
        : rewriteSkillReferences(parsed.body, this.#config.namePrefix, known);

    const definition = {
      name: this.skillName(name),
      description: candidate.description ?? '',
      invocation: candidate.invocation ?? { modelInvocable: true, userInvocable: true },
      source: this.#config.source,
      provider: this.name,
      path: docPath,
      content,
      metadata: {
        ...(candidate.metadata ?? {}),
        mattpocockSkills: {
          ...((candidate.metadata ?? {}).mattpocockSkills ?? {}),
          repo: this.#config.repo,
          upstreamVersion: state.upstreamVersion ?? null,
          commit: shortSha(sha),
        },
      },
    };
    if (candidate.resourceBase !== undefined) definition.resourceBase = candidate.resourceBase;
    if (typeof candidate.whenToUse === 'string') definition.whenToUse = candidate.whenToUse;
    return definition;
  }
}
