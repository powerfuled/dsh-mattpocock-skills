import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultDataDir, nowIso, readJsonFile, safeJoin, writeJsonAtomic } from './util.js';

export const STATE_VERSION = 1;

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    version: Number.isFinite(raw.version) ? raw.version : STATE_VERSION,
    repo: typeof raw.repo === 'string' ? raw.repo : undefined,
    ref: typeof raw.ref === 'string' ? raw.ref : undefined,
    currentSha: typeof raw.currentSha === 'string' ? raw.currentSha : null,
    upstreamVersion: typeof raw.upstreamVersion === 'string' ? raw.upstreamVersion : undefined,
    lastCheckedAt: typeof raw.lastCheckedAt === 'string' ? raw.lastCheckedAt : undefined,
    lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    overrides: raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides) ? { ...raw.overrides } : {},
    skills: Array.isArray(raw.skills) ? raw.skills.filter((skill) => skill && typeof skill.name === 'string') : [],
  };
}

/** Owns the on-disk mirror of the upstream repository plus the per-skill enable overrides. */
export class SkillStore {
  constructor(config = {}) {
    this.config = config;
    const configured = typeof config.dataDir === 'string' ? config.dataDir.trim() : '';
    this.dir = configured !== '' ? configured : defaultDataDir();
    this.statePath = join(this.dir, 'state.json');
    this.versionsDir = join(this.dir, 'versions');
    this._state = undefined;
  }

  /** Current snapshot; `null` before the first successful sync. */
  get state() {
    return this._state ?? null;
  }

  /** Load `state.json` (memoized unless `force`). */
  async load({ force = false } = {}) {
    if (this._state !== undefined && !force) return this._state;
    this._state = normalizeState(await readJsonFile(this.statePath, null));
    return this._state;
  }

  async save(state) {
    const next = { ...state, version: STATE_VERSION, updatedAt: nowIso() };
    this._state = next;
    await writeJsonAtomic(this.statePath, next);
    return next;
  }

  versionDir(sha) {
    return join(this.versionsDir, String(sha));
  }

  /** Absolute directory of one skill inside a materialized version, or undefined when unsafe. */
  skillDir(sha, skillPath) {
    return safeJoin(this.versionDir(sha), skillPath);
  }

  async hasVersion(sha) {
    try {
      const info = await stat(this.versionDir(sha));
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Effective enabled flag for one upstream skill.
   *
   * Precedence: runtime override (written by the management tool) → static
   * `disabledSkills` → static `enabledSkills` allowlist (when non-empty) →
   * `defaultEnabled`.
   */
  isEnabled(name, state = this._state) {
    const override = state?.overrides?.[name];
    if (typeof override === 'boolean') return override;
    const disabled = this.config.disabledSkills ?? [];
    if (disabled.includes(name)) return false;
    const enabled = this.config.enabledSkills ?? [];
    if (enabled.length > 0) return enabled.includes(name);
    return this.config.defaultEnabled !== false;
  }

  /** Record a runtime enable/disable override and persist it. */
  async setOverride(name, enabled) {
    const state = (await this.load()) ?? normalizeState({});
    const overrides = { ...(state.overrides ?? {}) };
    if (enabled === null) delete overrides[name];
    else overrides[name] = Boolean(enabled);
    return this.save({ ...state, overrides });
  }

  async clearOverrides() {
    const state = (await this.load()) ?? normalizeState({});
    return this.save({ ...state, overrides: {} });
  }

  /**
   * Delete abandoned staging directories and old materialized versions.
   * The current version is never removed; the newest `keep` others are retained.
   */
  async pruneVersions(keep = 3) {
    let names;
    try {
      names = await readdir(this.versionsDir);
    } catch {
      return [];
    }
    const current = this._state?.currentSha;
    const candidates = [];
    for (const name of names) {
      const full = join(this.versionsDir, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      if (name.includes('.staging-')) {
        await rm(full, { recursive: true, force: true });
        continue;
      }
      if (name === current) continue;
      candidates.push({ name, mtime: info.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const removed = [];
    for (const item of candidates.slice(Math.max(0, keep))) {
      await rm(join(this.versionsDir, item.name), { recursive: true, force: true });
      removed.push(item.name);
    }
    return removed;
  }
}
