# Changelog

All notable changes to `dsh-matt-pocock-skills` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-14

### Added

- DSH skill provider that mirrors [`mattpocock/skills`](https://github.com/mattpocock/skills) at
  runtime and exposes its skills through the DSH skill registry.
- Upstream-driven exposure: only the skills listed by the repository's release manifest
  (`.claude-plugin/plugin.json`) are published; `misc`, `in-progress` and `deprecated` stay hidden.
- `mp-` namespace prefix on every mirrored skill, with in-text skill references rewritten so
  cross-skill instructions keep resolving.
- Upstream invocation semantics: skills marked `disable-model-invocation: true` (16 of the 27) stay
  user-invoked only, as upstream intends; `honourInvocationFlags: false` makes every skill
  model-invocable.
- Commit-pinned mirrors: resolve the head commit through `api.github.com` (with an `info/refs`
  fallback), download the `codeload.github.com` archive, and unpack it with a dependency-free tar
  reader into `versions/<sha>/`; unsafe paths, symlinks and oversized entries are dropped.
- Frontmatter validation (kebab-case `name`, non-empty `description`) with invalid skills reported in
  the sync result instead of being exposed.
- Background sync (`syncOnStart`, `autoSync`, `syncIntervalHours`, `initialSyncDelaySeconds`) that is
  serialised, keeps the last good mirror on failure, and retains `keepVersions` revisions.
- Tools: `sync_mattpocock_skills` (manual / forced / dry-run sync) and `manage_mattpocock_skills`
  (`list`, `status`, `enable`, `disable`, `enable_all`, `disable_all`, `reset`) with immediate
  catalogue refresh — no restart required.
- Per-skill runtime overrides that take precedence over `defaultEnabled`, `enabledSkills` and
  `disabledSkills`.
- Configuration surface (`repo`, `ref`, `token`, `manifestPath`, `skillsRoot`, `categories`, `rank`,
  `namePrefix`, `dataDir`, `maxArchiveBytes`, `timeoutMs`, …) overridable from the profile's
  `cordis.patch.yml`.
- 40 unit tests plus an end-to-end smoke script that syncs the real upstream repository.

[0.1.0]: https://www.npmjs.com/package/dsh-matt-pocock-skills/v/0.1.0
