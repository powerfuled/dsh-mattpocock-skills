import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildSkillRecord, deriveCategory, parseUpstreamManifest } from './manifest.js';
import { extractTarGz } from './tar.js';
import { nowIso, readJsonFile, safeJoin, shortSha } from './util.js';

const INVENTORY_FILE = 'inventory.json';

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function discoverSkillDirectories(entries, skillsRoot) {
  const prefix = `${skillsRoot}/`;
  const suffix = '/SKILL.md';
  const found = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || !entry.path.endsWith(suffix)) continue;
    const dir = entry.path.slice(0, -suffix.length);
    if (!found.includes(dir)) found.push(dir);
  }
  return found.sort();
}

/**
 * Keeps a local mirror of the upstream repository in sync with its default branch.
 *
 * Every network failure is reported through the returned report instead of
 * throwing, and a failed check never destroys the last good mirror.
 */
export class SyncEngine {
  #queue = Promise.resolve();
  #inflight = null;
  #timers = [];

  constructor({ config, store, upstream, log, onChanged }) {
    this.config = config;
    this.store = store;
    this.upstream = upstream;
    this.log = log;
    this.onChanged = typeof onChanged === 'function' ? onChanged : () => {};
  }

  /** Run a sync; concurrent callers are serialized rather than racing. */
  sync(options = {}) {
    const run = this.#queue.then(
      () => this.#sync(options),
      () => this.#sync(options),
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Sync lazily when nothing has been mirrored yet, so the first catalog is populated. */
  async ensureLoaded({ signal } = {}) {
    const state = await this.store.load();
    if (state?.currentSha) return state;
    if (this.config.syncOnStart === false) return state ?? null;
    try {
      await this.sync({ signal });
    } catch (error) {
      this.log.warn(`initial sync failed: ${messageOf(error)}`);
    }
    return this.store.state;
  }

  /** A guarded automatic sync used by the timers. */
  runAuto(reason = 'scheduled') {
    if (this.#inflight) return this.#inflight;
    const promise = this.sync({})
      .then((report) => {
        if (report.updated) {
          this.log.info(
            `synced ${this.config.repo}@${this.config.ref} to ${shortSha(report.latestSha)} (${report.skillCount} skills)`,
          );
        }
        return report;
      })
      .catch((error) => {
        this.log.warn(`auto sync (${reason}) failed: ${messageOf(error)}`);
        return undefined;
      })
      .finally(() => {
        this.#inflight = null;
      });
    this.#inflight = promise;
    return promise;
  }

  start() {
    this.stop();
    const { config } = this;
    const timers = [];
    const autoSync = config.autoSync !== false;
    const syncOnStart = config.syncOnStart !== false;
    if (autoSync && syncOnStart) {
      const delayMs = Math.max(0, Number(config.initialSyncDelaySeconds) || 0) * 1000;
      timers.push(setTimeout(() => void this.runAuto('initial'), delayMs));
    }
    if (autoSync) {
      const everyMs = Math.max(60, Number(config.syncIntervalHours) || 24) * 3600 * 1000;
      timers.push(setInterval(() => void this.runAuto('scheduled'), everyMs));
    }
    for (const timer of timers) {
      if (typeof timer.unref === 'function') timer.unref();
    }
    this.#timers = timers;
    if (timers.length > 0) {
      this.log.debug(
        `auto sync armed (repo=${config.repo} ref=${config.ref} every=${config.syncIntervalHours}h)`,
      );
    }
  }

  stop() {
    for (const timer of this.#timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.#timers = [];
  }

  async #sync({ force = false, dryRun = false, signal } = {}) {
    const { config } = this;
    const state = await this.store.load();
    const report = {
      repo: config.repo,
      ref: config.ref,
      previousSha: state?.currentSha ?? null,
      latestSha: null,
      resolvedVia: null,
      updated: false,
      staged: false,
      upToDate: false,
      added: [],
      removed: [],
      changed: [],
      invalid: [],
      skillCount: (state?.skills ?? []).length,
      upstreamVersion: state?.upstreamVersion ?? null,
      checkedAt: nowIso(),
      error: null,
    };

    let resolved;
    try {
      resolved = await this.upstream.resolveSha(signal);
    } catch (error) {
      return this.#recordFailure(state, report, error);
    }
    report.latestSha = resolved.sha;
    report.resolvedVia = resolved.via;

    const hasMirror = await this.store.hasVersion(resolved.sha);
    if (!force && hasMirror && state?.currentSha === resolved.sha) {
      report.upToDate = true;
      return this.#recordCheck(state, report);
    }

    let snapshot;
    try {
      snapshot = await this.#materialize(resolved.sha, signal);
    } catch (error) {
      return this.#recordFailure(state, report, error);
    }

    const previous = new Map((state?.skills ?? []).map((skill) => [skill.name, skill]));
    const next = new Map(snapshot.skills.map((skill) => [skill.name, skill]));
    report.added = [...next.keys()].filter((name) => !previous.has(name)).sort();
    report.removed = [...previous.keys()].filter((name) => !next.has(name)).sort();
    report.changed = [...next.keys()]
      .filter((name) => previous.has(name) && previous.get(name).description !== next.get(name).description)
      .sort();
    report.invalid = snapshot.invalid;
    report.skillCount = snapshot.skills.length;
    report.upstreamVersion = snapshot.manifest.version ?? null;

    if (dryRun) {
      report.staged = true;
      return this.#recordCheck(state, report);
    }

    await this.store.save({
      ...(state ?? {}),
      repo: config.repo,
      ref: config.ref,
      currentSha: resolved.sha,
      upstreamVersion: snapshot.manifest.version,
      skills: snapshot.skills,
      overrides: state?.overrides ?? {},
      lastCheckedAt: report.checkedAt,
      lastSyncAt: nowIso(),
      lastError: null,
    });
    report.updated = true;
    try {
      this.onChanged(report);
    } catch (error) {
      this.log.warn(`catalog invalidation failed: ${messageOf(error)}`);
    }
    void this.store.pruneVersions(config.keepVersions);
    return report;
  }

  async #recordCheck(state, report) {
    if (state) {
      try {
        await this.store.save({ ...state, lastCheckedAt: report.checkedAt, lastError: null });
      } catch (error) {
        this.log.warn(`cannot record sync check: ${messageOf(error)}`);
      }
    }
    return report;
  }

  async #recordFailure(state, report, error) {
    report.error = messageOf(error);
    this.log.warn(`sync failed: ${report.error}`);
    if (state) {
      try {
        await this.store.save({ ...state, lastCheckedAt: report.checkedAt, lastError: report.error });
      } catch (cause) {
        this.log.warn(`cannot record sync failure: ${messageOf(cause)}`);
      }
    }
    return report;
  }

  /** Ensure `versions/<sha>` exists and holds a parsed inventory; returns the inventory. */
  async #materialize(sha, signal) {
    const { config } = this;
    const dir = this.store.versionDir(sha);
    const cached = await this.#readInventory(dir);
    if (cached) return cached;

    const archive = await this.upstream.downloadArchive(sha, signal);
    const entries = extractTarGz(archive, {
      stripComponents: 1,
      filter: (path) => path === config.manifestPath || path.startsWith(`${config.skillsRoot}/`),
    });

    const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      for (const entry of entries) {
        const target = safeJoin(staging, entry.path);
        if (target === undefined) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.data);
      }
      const snapshot = await this.#buildSnapshot({ dir: staging, entries, sha });
      await writeFile(
        join(staging, INVENTORY_FILE),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf8',
      );
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      return snapshot;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #readInventory(dir) {
    const cached = await readJsonFile(join(dir, INVENTORY_FILE), null);
    if (!cached || !Array.isArray(cached.skills)) return null;
    return cached;
  }

  async #buildSnapshot({ dir, entries, sha }) {
    const { config } = this;
    let manifest = {
      name: undefined,
      version: undefined,
      license: undefined,
      homepage: undefined,
      author: undefined,
      repository: undefined,
      skills: [],
    };
    try {
      const raw = JSON.parse(await readFile(join(dir, config.manifestPath), 'utf8'));
      manifest = parseUpstreamManifest(raw);
    } catch (error) {
      if (config.useUpstreamManifest !== false) {
        throw new Error(`cannot read the upstream release manifest ${config.manifestPath}: ${messageOf(error)}`);
      }
    }

    const directories =
      manifest.skills.length > 0 ? manifest.skills : discoverSkillDirectories(entries, config.skillsRoot);

    const categories = config.categories ?? [];
    const skills = [];
    const invalid = [];
    for (const skillPath of directories) {
      if (categories.length > 0 && !categories.includes(deriveCategory(skillPath, config.skillsRoot))) continue;
      const docPath = safeJoin(dir, skillPath, 'SKILL.md');
      if (docPath === undefined) {
        invalid.push({ path: skillPath, code: 'unsafe-path', message: `${skillPath}: unsafe skill path` });
        continue;
      }
      let docText;
      try {
        docText = await readFile(docPath, 'utf8');
      } catch (error) {
        invalid.push({
          path: skillPath,
          code: 'missing-skill-md',
          message: `${skillPath}/SKILL.md: ${messageOf(error)}`,
        });
        continue;
      }
      const built = buildSkillRecord({ skillPath, docText, skillsRoot: config.skillsRoot });
      if (!built.ok) {
        invalid.push({ path: skillPath, code: built.code, message: built.message });
        continue;
      }
      skills.push(built.record);
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return {
      sha,
      builtAt: nowIso(),
      fileCount: entries.length,
      manifest: {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        homepage: manifest.homepage,
        author: manifest.author,
        repository: manifest.repository,
      },
      skills,
      invalid,
    };
  }
}
