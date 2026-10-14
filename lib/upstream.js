const USER_AGENT = 'dsh-mattpocock-skills';
const SHA_RE = /^[0-9a-f]{40}$/i;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function combineSignals(signals) {
  const active = signals.filter((signal) => signal !== undefined && signal !== null);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  return active[0];
}

/** A network or upstream-protocol failure that the sync engine can report as a string. */
export class UpstreamError extends Error {
  constructor(message, { code = 'upstream-error', status } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Talk to the upstream GitHub repository: resolve the ref to a commit, download that commit's archive. */
export class UpstreamClient {
  constructor(config = {}) {
    this.repo = String(config.repo ?? '').trim();
    this.ref = String(config.ref ?? 'main').trim() || 'main';
    this.token = String(config.token ?? '').trim();
    this.timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30000;
    this.maxArchiveBytes = Number.isFinite(config.maxArchiveBytes)
      ? config.maxArchiveBytes
      : 64 * 1024 * 1024;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new UpstreamError('no fetch implementation available (requires Node.js >= 18)', {
        code: 'no-fetch',
      });
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repo)) {
      throw new UpstreamError(`invalid repository "${this.repo}" (expected "owner/name")`, {
        code: 'invalid-repo',
      });
    }
  }

  async #get(url, { accept, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), this.timeoutMs);
    const headers = { 'user-agent': USER_AGENT, accept: accept ?? '*/*' };
    if (this.token !== '') headers.authorization = `Bearer ${this.token}`;
    try {
      return await this.fetchImpl(url, {
        headers,
        redirect: 'follow',
        signal: combineSignals([signal, controller.signal]),
      });
    } catch (cause) {
      throw new UpstreamError(`request to ${url} failed: ${cause?.message ?? cause}`, {
        code: signal?.aborted ? 'aborted' : 'network-error',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the configured ref to a commit SHA.
   *
   * Uses the GitHub commits API first and falls back to the Git smart-HTTP
   * advertisement (`info/refs`), which is not rate limited the same way.
   *
   * @returns {Promise<{ sha: string, via: 'api' | 'info-refs' | 'literal' }>}
   */
  async resolveSha(signal) {
    if (SHA_RE.test(this.ref)) return { sha: this.ref.toLowerCase(), via: 'literal' };

    const apiError = await this.#resolveShaViaApi(signal).then(
      (sha) => sha,
      (error) => error,
    );
    if (typeof apiError === 'string') return { sha: apiError, via: 'api' };

    const fallback = await this.#resolveShaViaInfoRefs(signal).then(
      (sha) => sha,
      (error) => error,
    );
    if (typeof fallback === 'string') return { sha: fallback, via: 'info-refs' };

    throw new UpstreamError(
      `cannot resolve ${this.repo}@${this.ref}: ${apiError?.message ?? apiError}; ${fallback?.message ?? fallback}`,
      { code: 'resolve-failed' },
    );
  }

  async #resolveShaViaApi(signal) {
    const url = `https://api.github.com/repos/${this.repo}/commits/${encodeURIComponent(this.ref)}`;
    const response = await this.#get(url, {
      accept: 'application/vnd.github.sha, application/vnd.github+json',
      signal,
    });
    const text = (await response.text()).trim();
    if (!response.ok) {
      const reason = response.status === 403 || response.status === 429 ? 'rate-limited' : 'http-error';
      throw new UpstreamError(
        `GitHub API returned ${response.status} for ${url}${this.token === '' && reason === 'rate-limited' ? ' (set `token` to raise the anonymous limit)' : ''}`,
        { code: reason, status: response.status },
      );
    }
    if (SHA_RE.test(text)) return text.toLowerCase();
    try {
      const json = JSON.parse(text);
      const sha = json?.sha;
      if (typeof sha === 'string' && SHA_RE.test(sha)) return sha.toLowerCase();
    } catch {
      /* fall through to the explicit error below */
    }
    throw new UpstreamError(`GitHub API returned an unexpected body for ${url}`, { code: 'bad-response' });
  }

  async #resolveShaViaInfoRefs(signal) {
    const url = `https://github.com/${this.repo}.git/info/refs?service=git-upload-pack`;
    const response = await this.#get(url, { accept: '*/*', signal });
    const text = await response.text();
    if (!response.ok) {
      throw new UpstreamError(`git advertisement returned ${response.status} for ${url}`, {
        code: 'http-error',
        status: response.status,
      });
    }
    const pattern = new RegExp(
      `([0-9a-f]{40}) refs/(?:heads|tags)/${escapeRegExp(this.ref)}(?:\\^\\{\\})?(?:\\u0000|\\n)`,
      'i',
    );
    const match = pattern.exec(text);
    if (match) return match[1].toLowerCase();
    // Some proxies strip the trailing NUL/newline; retry without the terminator.
    const loose = new RegExp(`([0-9a-f]{40}) refs/(?:heads|tags)/${escapeRegExp(this.ref)}(?:\\^\\{\\})?`, 'i').exec(text);
    if (loose) return loose[1].toLowerCase();
    throw new UpstreamError(`ref "${this.ref}" not found in the git advertisement of ${this.repo}`, {
      code: 'ref-not-found',
    });
  }

  /** Download the tarball for a commit SHA and return its raw bytes. */
  async downloadArchive(sha, signal) {
    const url = `https://codeload.github.com/${this.repo}/tar.gz/${sha}`;
    const response = await this.#get(url, { accept: 'application/gzip, application/octet-stream', signal });
    if (!response.ok) {
      throw new UpstreamError(`archive download returned ${response.status} for ${url}`, {
        code: 'http-error',
        status: response.status,
      });
    }
    if (response.body === null || typeof response.body?.getReader !== 'function') {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > this.maxArchiveBytes) {
        throw new UpstreamError(`archive exceeds ${this.maxArchiveBytes} bytes`, { code: 'archive-too-large' });
      }
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxArchiveBytes) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError(`archive exceeds ${this.maxArchiveBytes} bytes`, { code: 'archive-too-large' });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}
