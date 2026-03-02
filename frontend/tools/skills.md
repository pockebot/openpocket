# Skills

OpenPocket skills are markdown instruction files loaded into the agent loop to provide reusable operational knowledge.

`agent.skillsSpecMode` controls compatibility behavior:

- `legacy`: permissive legacy markdown behavior
- `mixed`: supports legacy markdown + strict `SKILL.md` (default)
- `strict`: enforces strict `SKILL.md` layout + validation

## Source Order

Loader scan order (highest priority first):

1. repository `skills/` (`source=bundled`)
2. `OPENPOCKET_HOME/skills` (`source=local`)
3. `workspace/skills` (`source=workspace`)

If multiple files have the same skill ID, first source wins.

## Discovery

- recursive scan under each source root
- if a directory contains `SKILL.md`, that file is treated as the skill entry
- in `mixed|legacy`, standalone `*.md` files are also discovered (excluding `README.md`)
- in `strict`, only `SKILL.md` entries are loaded

This supports both:

- single-file skills (`foo.md`)
- folderized skills (`foo/SKILL.md` + optional assets/references)

## Metadata Parsing

For each skill, loader derives:

- `id`: file basename (or `SKILL` parent directory name)
- `name`: frontmatter `name`, else first level-1 heading, else `id`
- `description`: frontmatter `description`, else first non-heading line (<=180 chars)
- `source`: `workspace | local | bundled`
- `path`: absolute file path

Optional frontmatter metadata supports runtime gating:

- `openclaw.requires.bins`: required binaries
- `openclaw.requires.env`: required env vars
- `openclaw.requires.config`: required config keys
- `openclaw.os`: allowed platforms
- `openclaw.triggers.any|all|none`: lexical trigger hints

Skills that fail gating are not considered active candidates.

## Prompt Injection Model

Runtime injects two blocks:

1. **Skill summary index** (compact list for discovery)
2. **Active skill blocks** (full text snippets for top-ranked relevant skills)

Active skill selection uses:

- task text relevance
- current app context
- recent action trace keywords
- metadata trigger/gating checks

Default active injection limits:

- max active skills: 3
- max chars per active skill: 7000
- max chars total active block: 18000

## Auto-Skill Experience Engine

On successful tasks, `AutoArtifactBuilder` may generate:

- `mixed|legacy`: `workspace/skills/auto/<timestamp>-<slug>.md`
- `strict`: `workspace/skills/auto/<timestamp>-<slug>/SKILL.md`
- script replay helper: `workspace/scripts/auto/<timestamp>-<slug>.sh`

Generated auto skills include:

- source session path
- behavior fingerprint (`behavior_fingerprint`)
- procedure reconstructed from step traces
- semantic `ui_target` hints (text/resource/content-desc/class/clickable)
- warning marker when capability probe indicates user-data risk but no Human Auth step occurred

Duplicate cleanup is fingerprint-aware to avoid accumulating identical replay drafts.

## Authoring Template

```md
# Search App

Find and open app quickly by name.

## Trigger
Use when user asks to open an app by name.

## Steps
- Open launcher
- Type app name
- Tap app icon
```

Only title and first non-heading line are parsed structurally; the rest is free-form guidance for future prompt usage.

Use CLI validation to check strict compatibility:

```bash
openpocket skills validate --strict
```

Manage workspace-installed skills:

```bash
openpocket skills list
openpocket skills load
openpocket skills load --all
```
