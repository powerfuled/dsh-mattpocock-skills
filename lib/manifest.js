import { parseFrontmatter, readStringField } from './frontmatter.js';
import { isReservedDeviceName, isSkillName, normalizeRepoPath } from './util.js';

/**
 * Parse the upstream `.claude-plugin/plugin.json` release manifest.
 *
 * Only directories listed in `skills[]` are part of the published surface;
 * everything else in the repository (misc/, deprecated/, in-progress/,
 * .out-of-scope/) stays out of the DSH catalog.
 *
 * @param {unknown} json parsed manifest JSON.
 */
export function parseUpstreamManifest(json) {
  const raw = Array.isArray(json?.skills) ? json.skills : [];
  const skills = [];
  for (const entry of raw) {
    const candidate =
      typeof entry === 'string'
        ? entry
        : [entry?.path, entry?.source, entry?.dir].find((value) => typeof value === 'string');
    const path = normalizeRepoPath(candidate);
    if (path === undefined) continue;
    if (!skills.includes(path)) skills.push(path);
  }
  return {
    name: typeof json?.name === 'string' ? json.name : undefined,
    version: typeof json?.version === 'string' ? json.version : undefined,
    description: typeof json?.description === 'string' ? json.description : undefined,
    license: typeof json?.license === 'string' ? json.license : undefined,
    homepage: typeof json?.homepage === 'string' ? json.homepage : undefined,
    repository: typeof json?.repository === 'string' ? json.repository : json?.repository?.url,
    author: typeof json?.author === 'string' ? json.author : json?.author?.name,
    skills,
  };
}

/** Derive the category label (first segment below the skills root) for a skill directory. */
export function deriveCategory(skillPath, skillsRoot = 'skills') {
  const root = normalizeRepoPath(skillsRoot) ?? '';
  const relative = root !== '' && skillPath.startsWith(`${root}/`) ? skillPath.slice(root.length + 1) : skillPath;
  const segments = relative.split('/').filter((segment) => segment !== '');
  return segments.length > 1 ? segments[0] : 'general';
}

/**
 * Read the upstream frontmatter invocation flags.
 *
 * Upstream marks a skill that the user drives (rather than the model) with
 * `disable-model-invocation: true`, and can hide one from the user with
 * `user-invocable: false`. Both default to permissive.
 */
function readInvocation(data) {
  const disableModel = data?.['disable-model-invocation'] ?? data?.disableModelInvocation;
  const userInvocable = data?.['user-invocable'] ?? data?.userInvocable;
  return {
    modelInvocable: disableModel !== true,
    userInvocable: userInvocable !== false,
  };
}

/**
 * Build a skill record from a fetched `SKILL.md` document.
 *
 * @param {{ skillPath: string, docText: string, skillsRoot?: string }} input
 * @returns {{ ok: true, record: object } | { ok: false, code: string, message: string }}
 */
export function buildSkillRecord({ skillPath, docText, skillsRoot = 'skills' }) {
  const parsed = parseFrontmatter(docText);
  if (parsed.error !== undefined) {
    return { ok: false, code: 'invalid-frontmatter', message: `${skillPath}/SKILL.md: ${parsed.error}` };
  }

  const declared = readStringField(parsed.data, 'name', 'title');
  const directory = skillPath.split('/').filter(Boolean).pop();
  const name = declared ?? directory;

  if (name === undefined || !isSkillName(name)) {
    return { ok: false, code: 'invalid-name', message: `${skillPath}/SKILL.md: invalid skill name "${name ?? ''}"` };
  }
  if (isReservedDeviceName(name)) {
    return { ok: false, code: 'reserved-name', message: `${skillPath}/SKILL.md: reserved device name "${name}"` };
  }

  const description = readStringField(parsed.data, 'description', 'summary');
  if (description === undefined) {
    return { ok: false, code: 'missing-description', message: `${skillPath}/SKILL.md: missing description` };
  }

  const whenToUse = readStringField(parsed.data, 'whenToUse', 'when-to-use', 'when_to_use');
  const { name: _name, description: _description, ...rest } = parsed.data;

  return {
    ok: true,
    record: {
      name,
      declaredName: declared,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      category: deriveCategory(skillPath, skillsRoot),
      path: skillPath,
      invocation: readInvocation(parsed.data),
      frontmatter: rest,
    },
  };
}
