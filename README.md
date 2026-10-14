# dsh-matt-pocock-skills

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that mirrors
**[Matt Pocock's agent skills](https://github.com/mattpocock/skills)** into DSH and keeps them in sync
with the upstream repository.

[中文说明](./README.zh-CN.md)

## What it does

- **Mirrors the upstream repository at runtime.** The plugin downloads the GitHub archive of
  `mattpocock/skills` into a local cache and registers its skills through the DSH skill registry
  (`ctx.skills.registerProvider`). No skill file is vendored into this npm package.
- **Only ships what upstream ships.** It reads the skills listed by the repository's release manifest
  (`.claude-plugin/plugin.json`, currently 27 skills) and ignores `skills/misc/`,
  `skills/in-progress/` and `skills/deprecated/` entirely.
- **Namespaces every skill with `mp-`.** Upstream `tdd` becomes `mp-tdd`, so an upstream skill can
  never shadow one of your own. Cross-skill references inside the skill text are rewritten to the
  prefixed names, so `mp-implement` can still tell the agent to load `mp-tdd`.
- **Syncs itself.** A background sync runs shortly after startup and then every `syncIntervalHours`
  (24 h by default). Every sync is serialised, a failed sync keeps the last good mirror, and each
  mirror is keyed by commit sha so a rollout is atomic.
- **Manage it per skill.** `manage_mattpocock_skills` lists every mirrored skill and turns individual
  skills on or off at runtime — no restart, no file edits, and the override survives re-syncs.
- **Works offline.** If the network is unavailable at startup the plugin simply exposes the last
  mirrored version (or nothing, on a first run) and records the error in its state file.

## Requirements

- DSH `0.2.0-rc.2` or newer (the skill-provider API version this plugin is built against).
- Node.js `^22.19.0 || >=24.0.0`.
- Network access to `api.github.com` and `codeload.github.com` for syncing (`git` is **not** required).

## Install

### From npm (recommended)

```bash
dsh plugin --profile <profile> add dsh-matt-pocock-skills
```

Or install it from the DSH plugin manager / plugin market UI. The package declares a bundle patch, so
mounting it is automatic.

### Manual mount (works before publishing)

The plugin only needs to be resolvable from the profile and referenced once in the profile's patch
layer, `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: mattpocock-skills
      name: dsh-matt-pocock-skills
      config:
        syncIntervalHours: 12
```

If you keep the source in a working copy instead, point the loader at that working copy:

```yaml
- insert:
    - id: mattpocock-skills
      name: 'file:///D:/dsh工作区/dsh-mattpocock-skills/lib/index.js'
```

Restart DSH (or let the loader hot-reload the patch) and the mirrored skills appear in the skill
catalogue as `mp-*`.

## Configuration

All options are optional and live on the plugin's own entry in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mattpocock-skills
  name: dsh-matt-pocock-skills
  config:
    categories: ["engineering"]
    disabledSkills: ["retro"]
    syncIntervalHours: 12
```

| Option | Default | Description |
| --- | --- | --- |
| `repo` | `mattpocock/skills` | Upstream repository, `owner/name`. |
| `ref` | `main` | Branch, tag or commit sha to mirror. |
| `token` | `''` | Optional GitHub token: raises the API rate limit, allows a private mirror. |
| `manifestPath` | `.claude-plugin/plugin.json` | Upstream release manifest that lists the shipped skills. |
| `skillsRoot` | `skills` | Directory in the repository that holds skill folders. |
| `useUpstreamManifest` | `true` | Expose exactly the manifest's skills (set `false` to discover every `*/SKILL.md`). |
| `categories` | `[]` | Restrict to categories such as `engineering` or `productivity`; empty means all. |
| `namePrefix` | `mp-` | Prefix applied to every skill name. |
| `rank` | `700` | Provider precedence. Lower wins, so mirrored skills stay below bundled (600) and filesystem (100–500) skills. |
| `source` | `custom` | Source label shown in the skill catalogue. |
| `rewriteSkillReferences` | `true` | Rewrite in-text skill references to prefixed names. |
| `honourInvocationFlags` | `true` | Keep upstream's `disable-model-invocation` / `user-invocable` flags; set `false` to make every skill model-invocable. |
| `defaultEnabled` | `true` | Initial enablement for skills without a runtime override. |
| `enabledSkills` | `[]` | Allow-list applied when `defaultEnabled` is `false`. |
| `disabledSkills` | `[]` | Deny-list applied after the allow-list. |
| `syncOnStart` | `true` | Mirror upstream once at startup if nothing is mirrored yet. |
| `autoSync` | `true` | Keep the mirror fresh in the background. |
| `initialSyncDelaySeconds` | `10` | Delay before the first background sync. |
| `syncIntervalHours` | `24` | Background sync cadence. |
| `keepVersions` | `3` | How many mirrored commits are retained for instant rollback. |
| `maxArchiveBytes` | `33554432` | Hard cap on the downloaded archive size (32 MiB). |
| `timeoutMs` | `30000` | Per-request network timeout. |
| `dataDir` | `''` | Mirror location; empty means `<DSH_HOME>/plugin-data/dsh-mattpocock-skills`. |
| `registerTools` | `true` | Register the two agent tools described below. |

## Skill catalogue and invocation

The mirror ships upstream's 27 published skills, renamed with the `mp-` prefix (`mp-tdd`,
`mp-codebase-design`, ...). Their bodies stay untouched except for skill-to-skill references, which
are rewritten to the prefixed names; sibling links such as `[tests.md](tests.md)` keep working
because the whole skill folder is mirrored.

Upstream marks 16 of the 27 skills as user-driven with `disable-model-invocation: true`
(`ask-matt`, `grill-me`, `grill-with-docs`, `handoff`, `implement`, `implement-spec`,
`improve-codebase-architecture`, `retro`, `setup-matt-pocock-skills`, `teach`, `to-questionnaire`,
`to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`). By default those stay user-invoked
only, exactly as upstream intends; the remaining 11 are also available to the model. Set
`honourInvocationFlags: false` to make all 27 model-invocable.

Editing plugin *config* in the patch layer is picked up live. Editing the plugin's own `lib/*.js`
needs a DSH restart.

## Tools

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `sync_mattpocock_skills` | `force` (boolean, default `false`), `dryRun` (boolean, default `false`) | Check upstream and mirror a newer revision. Reports the previous and latest commit, whether anything changed, and the per-skill diff (added / removed / changed / invalid). `force` re-stages the current commit, `dryRun` reports what would happen without touching the mirror. |
| `manage_mattpocock_skills` | `action` (one of `list`, `status`, `enable`, `disable`, `enable_all`, `disable_all`, `reset`), `skills` (array of skill names) | Inspect and toggle the mirrored skills. `reset` clears runtime overrides. Skill names without the `mp-` prefix are accepted. |

Both tools refresh the live skill catalogue immediately, so a toggle takes effect in the next turn
without restarting DSH.

## How it works

```
upstream commit sha ──► codeload tar.gz ──► extract ──► cache ──► skill candidates ──► DSH catalogue
                     (api.github.com)   (skills/…)  (versions/<sha>)     (mp-* prefix)
```

1. **Resolve.** The plugin asks the GitHub API for the head commit of `ref` (falling back to the
   repository's `info/refs`), so a sync happens only when upstream actually moved.
2. **Download & extract.** The commit's `codeload.github.com` archive is gunzipped and unpacked by a
   dependency-free tar reader into `versions/<sha>/`. Entries are stripped of their archive root and
   filtered to the manifest plus the skills tree; unsafe paths (absolute, `..`, symlinks) are dropped.
3. **Validate.** Each `SKILL.md` must carry YAML frontmatter with a kebab-case `name` and a non-empty
   `description`. Invalid skills are reported in the sync result instead of being exposed.
4. **Serve.** The provider lists the enabled skills as `mp-*` candidates and returns the file body on
   `get`, with `resourceBase` pointing at the mirrored folder, so sidecar files referenced by a skill
   (`tests.md`, `mocking.md`, format guides, templates) resolve next to the skill itself.

### Data layout

```
<DSH_HOME>/plugin-data/dsh-mattpocock-skills/
├── state.json                  # current commit, overrides, last sync result, skill index
└── versions/
    └── <commit-sha>/
        ├── inventory.json      # the skill index for this revision
        └── skills/<category>/<skill>/SKILL.md …
```

Deleting the directory is always safe: the next sync recreates it.

## Upstream and licensing

- Upstream: <https://github.com/mattpocock/skills> — MIT, © Matt Pocock. See [NOTICE.md](./NOTICE.md).
- This plugin ships **no** upstream content. It downloads the repository from GitHub on the user's
  machine at runtime; the mirrored files stay under `<DSH_HOME>/plugin-data/` and inherit the
  upstream MIT licence there.
- This plugin's own code is MIT licensed (see [LICENSE](./LICENSE)).

## Development

```bash
npm test        # 38 unit tests (tar reader, manifest/frontmatter parsing, store, sync, provider, plugin)
npm run smoke   # end-to-end sync against the real upstream repository into .scratch/smoke
```

The smoke script writes to `./.scratch/smoke`, so it never touches your installed mirror.
