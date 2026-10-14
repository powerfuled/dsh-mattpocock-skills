# NOTICE

`@powefuled/dsh-matt-pocock-skills` is a DeepSeek Harness integration for a third-party skills repository.

## Upstream

- **Project:** Matt Pocock's agent skills
- **Repository:** <https://github.com/mattpocock/skills>
- **Author:** Matt Pocock (<https://www.aihero.dev>)
- **Licence:** MIT
- **Mirrored revision:** the head commit of `main` at the time of each sync

## What this package contains

This npm package contains **no** upstream skills, text, templates or other content. It contains only
the integration code that talks to the upstream repository.

The upstream skills are downloaded by the user's own DSH instance at runtime, straight from
`codeload.github.com`, and are stored under `<DSH_HOME>/plugin-data/dsh-mattpocock-skills/versions/`.
Those downloaded files remain under the upstream MIT licence and keep Matt Pocock's copyright; they
are not redistributed by this package, by npm, or by its publisher.

Because the integration serves upstream content under DSH skill names, every mirrored skill is
prefixed with `mp-` to keep the upstream namespace visually distinct from your own skills.

## Trademarks

"DeepSeek Harness" and "DSH" refer to the host application this plugin extends. "Matt Pocock's agent
skills" refers to the upstream project above. Neither name implies endorsement of this plugin by the
respective owners.
