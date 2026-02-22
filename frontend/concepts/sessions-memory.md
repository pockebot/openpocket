# Sessions and Memory

OpenPocket persists execution and context as markdown/json artifacts under workspace.

## Workspace Bootstrap

On config load / onboarding, `ensureWorkspaceBootstrap` ensures directories:

- `workspace/memory`
- `workspace/sessions`
- `workspace/skills`
- `workspace/scripts`
- `workspace/scripts/runs`
- `workspace/cron`
- `workspace/.openpocket`

And default files (if missing):

- `AGENTS.md`
- `BOOTSTRAP.md` (fresh workspace onboarding gate)
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `MEMORY.md`
- `PROFILE_ONBOARDING.json`
- `TASK_PROGRESS_REPORTER.md`
- `TASK_OUTCOME_REPORTER.md`
- `BARE_SESSION_RESET_PROMPT.md`

## Onboarding Lifecycle Persistence

Workspace state file:

- `workspace/.openpocket/workspace-state.json`

Key timestamps:

- `bootstrapSeededAt`
- `onboardingCompletedAt`

When onboarding completes:

- `IDENTITY.md` and `USER.md` are persisted
- `BOOTSTRAP.md` is removed
- `onboardingCompletedAt` is written

## Session Lifecycle

For each task, runtime creates:

- `workspace/sessions/session-<timestamp>.md`

During run, each step appends:

- thought text
- normalized action JSON
- executor result text

At completion/failure, runtime appends final block with status and message.

## Daily Memory

Runtime appends one compact line per task to:

- `workspace/memory/YYYY-MM-DD.md`

Line contains:

- local time
- status (`OK` or `FAIL`)
- model profile key
- task summary
- compact result summary

## Memory Recall Tools

Task loop includes memory-specific tools:

- `memory_search`: search `MEMORY.md` + `memory/*.md`
- `memory_get`: read targeted line ranges from those files

Prompt policy encourages memory-first retrieval before answering prior-decision/preference/history questions.

## Screenshots

When enabled (`screenshots.saveStepScreenshots=true`):

- each step screenshot is saved locally
- optional screenshot path is appended to step result text
- debug marker overlays may be saved for tap/swipe steps

Retention policy:

- keep newest `screenshots.maxCount`
- delete oldest PNG files when over limit

## Auto Task Sedimentation

After successful tasks, runtime may auto-generate reusable artifacts:

- skill markdown: `workspace/skills/auto/*.md`
- replay script: `workspace/scripts/auto/*.sh`

These artifacts are surfaced in task result and used by outcome narration.
