import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The public skill-name grammar used by the DSH skill registry. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Whether `name` is a valid, portable skill identifier. */
export function isSkillName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && SKILL_NAME_RE.test(name);
}

/** Whether `name` collides with a Windows reserved device name. */
export function isReservedDeviceName(name) {
  return WINDOWS_RESERVED.has(String(name ?? '').toLowerCase());
}

/** Resolve the DSH home directory (`DSH_HOME`, else `~/.dsh`). */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/** Default runtime data directory for this plugin. */
export function defaultDataDir() {
  return join(resolveDshHome(), 'plugin-data', 'dsh-mattpocock-skills');
}

export function nowIso() {
  return new Date().toISOString();
}

/** Read and parse JSON, returning `fallback` when the file is missing or corrupt. */
export async function readJsonFile(path, fallback = undefined) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return fallback;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Write a file through a same-directory temp file plus rename. */
export async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

export async function writeJsonAtomic(path, value) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Join under `root`, returning `undefined` when the result escapes `root`. */
export function safeJoin(root, ...parts) {
  const base = resolve(root);
  const cleaned = parts.map((part) => String(part ?? '').replace(/^[/\\]+/, ''));
  const target = resolve(base, ...cleaned);
  if (target === base) return target;
  return target.startsWith(base + sep) ? target : undefined;
}

/** Whether a POSIX-style archive path is a safe relative path (no traversal, no absolute). */
export function isSafeRelativePath(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (isAbsolute(path)) return false;
  if (path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Strip leading `./`, leading and trailing slashes; return undefined when empty. */
export function normalizeRepoPath(input) {
  const value = String(input ?? '').trim().replace(/\\/g, '/');
  const stripped = value.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return stripped === '' ? undefined : stripped;
}

/** Remove the first `count` path segments (tar `--strip-components`). */
export function stripComponents(path, count) {
  if (count <= 0) return path;
  const parts = String(path).split('/');
  if (parts.length <= count) return undefined;
  const rest = parts.slice(count).join('/');
  return rest === '' ? undefined : rest;
}

export function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : String(sha ?? '');
}

/** Coerce a value into a trimmed, de-duplicated string array. */
export function uniqueStrings(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (text !== '' && !out.includes(text)) out.push(text);
  }
  return out;
}

/** Clamp a numeric option. */
export function clampNumber(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** A logger that falls back to the console when the host provides none. */
export function makeLogger(ctx, label = 'dsh-mattpocock-skills') {
  const prefix = `[${label}]`;
  try {
    if (ctx && typeof ctx.logger === 'function') {
      const logger = ctx.logger(label);
      if (logger && typeof logger.info === 'function') return logger;
    }
  } catch {
    /* fall through to console */
  }
  return {
    debug: () => {},
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}
