import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split a Markdown document into its YAML frontmatter mapping and its body.
 *
 * @param {string} text raw document text.
 * @returns {{ data: Record<string, unknown>, body: string, hasFrontmatter: boolean, error?: string }}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { data: {}, body: source.trim(), hasFrontmatter: false };

  let data = {};
  let error;
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed;
    } else if (parsed !== null && parsed !== undefined) {
      error = 'frontmatter is not a mapping';
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return {
    data,
    body: source.slice(match[0].length).trim(),
    hasFrontmatter: true,
    ...(error === undefined ? {} : { error }),
  };
}

/** Read the first non-empty string-ish field among `keys`. */
export function readStringField(data, ...keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}
