import { createTarGz } from '../lib/tar.js';

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);

export const SILENT_LOG = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A `SKILL.md` document with valid frontmatter. */
export function skillDoc(name, description, body = 'body') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/**
 * Build a GitHub-style source tarball.
 *
 * @param {string} sha commit the archive pretends to belong to
 * @param {{ manifest: object, files: Record<string, string> }} spec
 */
export function makeArchive(sha, spec) {
  const prefix = `mattpocock-skills-${sha}`;
  const files = [
    {
      path: `${prefix}/.claude-plugin/plugin.json`,
      data: JSON.stringify(spec.manifest, null, 2),
    },
  ];
  for (const [path, data] of Object.entries(spec.files)) {
    files.push({ path: `${prefix}/${path}`, data });
  }
  return createTarGz(files);
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async text() {
      return text;
    },
    async arrayBuffer() {
      const buffer = Buffer.from(text, 'utf8');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function binaryResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async text() {
      return buffer.toString('utf8');
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

/**
 * A `fetch` stand-in that answers the GitHub commits API and codeload.
 *
 * @param {{ sha: string | (() => string), archive: Buffer | (() => Buffer), fail?: (url: string) => Error | undefined }} options
 */
export function stubFetch(options) {
  const calls = [];
  const pick = (value) => (typeof value === 'function' ? value() : value);
  const impl = async (url) => {
    calls.push(url);
    const failure = options.fail?.(url);
    if (failure) throw failure;
    if (url.includes('api.github.com')) return textResponse(pick(options.sha));
    if (url.includes('codeload.github.com')) return binaryResponse(pick(options.archive));
    if (url.includes('info/refs')) {
      return textResponse(`001e# service=git-upload-pack\n0000${pick(options.sha)} refs/heads/main\n`);
    }
    return textResponse('not found', 404);
  };
  impl.calls = calls;
  return impl;
}

/** A minimal stand-in for the DSH plugin context. */
export function createFakeContext() {
  const providers = [];
  const registeredTools = new Map();
  const effects = [];
  const events = [];
  const invalidations = [];
  return {
    skills: {
      registerProvider(create) {
        const provider = create({
          signal: new AbortController().signal,
          invalidate: () => invalidations.push(provider?.name ?? 'unknown'),
        });
        providers.push(provider);
        return () => {
          const index = providers.indexOf(provider);
          if (index >= 0) providers.splice(index, 1);
        };
      },
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition);
        return () => registeredTools.delete(definition.name);
      },
    },
    effect(setup, label) {
      const dispose = setup();
      const entry = { label, dispose };
      effects.push(entry);
      return () => {
        const index = effects.indexOf(entry);
        if (index >= 0) effects.splice(index, 1);
        if (typeof dispose === 'function') dispose();
      };
    },
    emit(event) {
      events.push(event);
    },
    logger: () => SILENT_LOG,
    providers,
    registeredTools,
    effects,
    events,
    invalidations,
  };
}
